import { Directive, NgZone, OnDestroy, OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { firstValueFrom, Subject } from "rxjs";
import { concatMap, take, takeUntil } from "rxjs/operators";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { VaultTimeoutSettingsService } from "@bitwarden/common/abstractions/vault-timeout/vault-timeout-settings.service";
import { VaultTimeoutService } from "@bitwarden/common/abstractions/vault-timeout/vault-timeout.service";
import { PolicyApiServiceAbstraction } from "@bitwarden/common/admin-console/abstractions/policy/policy-api.service.abstraction";
import { InternalPolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { MasterPasswordPolicyOptions } from "@bitwarden/common/admin-console/models/domain/master-password-policy-options";
import { DeviceTrustCryptoServiceAbstraction } from "@bitwarden/common/auth/abstractions/device-trust-crypto.service.abstraction";
import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import { ForceResetPasswordReason } from "@bitwarden/common/auth/models/domain/force-reset-password-reason";
import { KdfConfig } from "@bitwarden/common/auth/models/domain/kdf-config";
import { SecretVerificationRequest } from "@bitwarden/common/auth/models/request/secret-verification.request";
import { MasterPasswordPolicyResponse } from "@bitwarden/common/auth/models/response/master-password-policy.response";
import { HashPurpose, KdfType, KeySuffixOptions } from "@bitwarden/common/enums";
import { VaultTimeoutAction } from "@bitwarden/common/enums/vault-timeout-action.enum";
import { CryptoService } from "@bitwarden/common/platform/abstractions/crypto.service";
import { EnvironmentService } from "@bitwarden/common/platform/abstractions/environment.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { StateService } from "@bitwarden/common/platform/abstractions/state.service";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { EncString } from "@bitwarden/common/platform/models/domain/enc-string";
import { UserKey } from "@bitwarden/common/platform/models/domain/symmetric-crypto-key";
import { PinLockType } from "@bitwarden/common/services/vault-timeout/vault-timeout-settings.service";
import { PasswordStrengthServiceAbstraction } from "@bitwarden/common/tools/password-strength";
import { DialogService } from "@bitwarden/components";

@Directive()
export class LockComponent implements OnInit, OnDestroy {
  masterPassword = "";
  pin = "";
  showPassword = false;
  email: string;
  pinEnabled = false;
  masterPasswordEnabled = false;
  webVaultHostname = "";
  formPromise: Promise<MasterPasswordPolicyResponse>;
  supportsBiometric: boolean;
  biometricLock: boolean;
  biometricText: string;

  protected successRoute = "vault";
  protected forcePasswordResetRoute = "update-temp-password";
  protected onSuccessfulSubmit: () => Promise<void>;

  private invalidPinAttempts = 0;
  private pinStatus: PinLockType;

  private enforcedMasterPasswordOptions: MasterPasswordPolicyOptions = undefined;

  private destroy$ = new Subject<void>();

  constructor(
    protected router: Router,
    protected i18nService: I18nService,
    protected platformUtilsService: PlatformUtilsService,
    protected messagingService: MessagingService,
    protected cryptoService: CryptoService,
    protected vaultTimeoutService: VaultTimeoutService,
    protected vaultTimeoutSettingsService: VaultTimeoutSettingsService,
    protected environmentService: EnvironmentService,
    protected stateService: StateService,
    protected apiService: ApiService,
    protected logService: LogService,
    protected ngZone: NgZone,
    protected policyApiService: PolicyApiServiceAbstraction,
    protected policyService: InternalPolicyService,
    protected passwordStrengthService: PasswordStrengthServiceAbstraction,
    protected dialogService: DialogService,
    protected deviceTrustCryptoService: DeviceTrustCryptoServiceAbstraction,
    protected userVerificationService: UserVerificationService
  ) {}

  async ngOnInit() {
    this.stateService.activeAccount$
      .pipe(
        concatMap(async () => {
          await this.load();
        }),
        takeUntil(this.destroy$)
      )
      .subscribe();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async submit() {
    if (this.pinEnabled) {
      return await this.handlePinRequiredUnlock();
    }

    await this.handleMasterPasswordRequiredUnlock();
  }

  async logOut() {
    const confirmed = await this.dialogService.openSimpleDialog({
      title: { key: "logOut" },
      content: { key: "logOutConfirmation" },
      acceptButtonText: { key: "logOut" },
      type: "warning",
    });

    if (confirmed) {
      this.messagingService.send("logout");
    }
  }

  async unlockBiometric(): Promise<boolean> {
    if (!this.biometricLock) {
      return;
    }

    const userKey = await this.cryptoService.getUserKeyFromStorage(KeySuffixOptions.Biometric);

    if (userKey) {
      await this.setUserKeyAndContinue(userKey, false);
    }

    return !!userKey;
  }

  togglePassword() {
    this.showPassword = !this.showPassword;
    const input = document.getElementById(this.pinEnabled ? "pin" : "masterPassword");
    if (this.ngZone.isStable) {
      input.focus();
    } else {
      this.ngZone.onStable.pipe(take(1)).subscribe(() => input.focus());
    }
  }

  private async handlePinRequiredUnlock() {
    if (this.pin == null || this.pin === "") {
      this.platformUtilsService.showToast(
        "error",
        this.i18nService.t("errorOccurred"),
        this.i18nService.t("pinRequired")
      );
      return;
    }

    return await this.doUnlockWithPin();
  }

  private async doUnlockWithPin() {
    let failed = true;
    try {
      const kdf = await this.stateService.getKdfType();
      const kdfConfig = await this.stateService.getKdfConfig();
      let userKeyPin: EncString;
      let oldPinKey: EncString;
      switch (this.pinStatus) {
        case "PERSISTANT": {
          userKeyPin = await this.stateService.getPinKeyEncryptedUserKey();
          const oldEncryptedPinKey = await this.stateService.getEncryptedPinProtected();
          oldPinKey = oldEncryptedPinKey ? new EncString(oldEncryptedPinKey) : undefined;
          break;
        }
        case "TRANSIENT": {
          userKeyPin = await this.stateService.getPinKeyEncryptedUserKeyEphemeral();
          oldPinKey = await this.stateService.getDecryptedPinProtected();
          break;
        }
        case "DISABLED": {
          throw new Error("Pin is disabled");
        }
        default: {
          const _exhaustiveCheck: never = this.pinStatus;
          return _exhaustiveCheck;
        }
      }

      let userKey: UserKey;
      if (oldPinKey) {
        userKey = await this.decryptAndMigrateOldPinKey(
          this.pinStatus === "TRANSIENT",
          kdf,
          kdfConfig,
          oldPinKey
        );
      } else {
        userKey = await this.cryptoService.decryptUserKeyWithPin(
          this.pin,
          this.email,
          kdf,
          kdfConfig,
          userKeyPin
        );
      }

      const protectedPin = await this.stateService.getProtectedPin();
      const decryptedPin = await this.cryptoService.decryptToUtf8(
        new EncString(protectedPin),
        userKey
      );
      failed = decryptedPin !== this.pin;

      if (!failed) {
        await this.setUserKeyAndContinue(userKey);
      }
    } catch {
      failed = true;
    }

    if (failed) {
      this.invalidPinAttempts++;
      if (this.invalidPinAttempts >= 5) {
        this.messagingService.send("logout");
        return;
      }
      this.platformUtilsService.showToast(
        "error",
        this.i18nService.t("errorOccurred"),
        this.i18nService.t("invalidPin")
      );
    }
  }

  private async handleMasterPasswordRequiredUnlock() {
    if (this.masterPassword == null || this.masterPassword === "") {
      this.platformUtilsService.showToast(
        "error",
        this.i18nService.t("errorOccurred"),
        this.i18nService.t("masterPasswordRequired")
      );
      return;
    }
    await this.doUnlockWithMasterPassword();
  }

  private async doUnlockWithMasterPassword() {
    const kdf = await this.stateService.getKdfType();
    const kdfConfig = await this.stateService.getKdfConfig();

    const masterKey = await this.cryptoService.makeMasterKey(
      this.masterPassword,
      this.email,
      kdf,
      kdfConfig
    );
    const storedPasswordHash = await this.cryptoService.getMasterKeyHash();

    let passwordValid = false;

    if (storedPasswordHash != null) {
      // Offline unlock possible
      passwordValid = await this.cryptoService.compareAndUpdateKeyHash(
        this.masterPassword,
        masterKey
      );
    } else {
      // Online only
      const request = new SecretVerificationRequest();
      const serverKeyHash = await this.cryptoService.hashMasterKey(
        this.masterPassword,
        masterKey,
        HashPurpose.ServerAuthorization
      );
      request.masterPasswordHash = serverKeyHash;
      try {
        this.formPromise = this.apiService.postAccountVerifyPassword(request);
        const response = await this.formPromise;
        this.enforcedMasterPasswordOptions = MasterPasswordPolicyOptions.fromResponse(response);
        passwordValid = true;
        const localKeyHash = await this.cryptoService.hashMasterKey(
          this.masterPassword,
          masterKey,
          HashPurpose.LocalAuthorization
        );
        await this.cryptoService.setMasterKeyHash(localKeyHash);
      } catch (e) {
        this.logService.error(e);
      } finally {
        this.formPromise = null;
      }
    }

    if (!passwordValid) {
      this.platformUtilsService.showToast(
        "error",
        this.i18nService.t("errorOccurred"),
        this.i18nService.t("invalidMasterPassword")
      );
      return;
    }

    const userKey = await this.cryptoService.decryptUserKeyWithMasterKey(masterKey);
    await this.cryptoService.setMasterKey(masterKey);
    await this.setUserKeyAndContinue(userKey, true);
  }

  private async setUserKeyAndContinue(key: UserKey, evaluatePasswordAfterUnlock = false) {
    await this.cryptoService.setUserKey(key);

    // Now that we have a decrypted user key in memory, we can check if we
    // need to establish trust on the current device
    await this.deviceTrustCryptoService.trustDeviceIfRequired();

    await this.doContinue(evaluatePasswordAfterUnlock);
  }

  private async doContinue(evaluatePasswordAfterUnlock: boolean) {
    await this.stateService.setEverBeenUnlocked(true);
    this.messagingService.send("unlocked");

    if (evaluatePasswordAfterUnlock) {
      try {
        // If we do not have any saved policies, attempt to load them from the service
        if (this.enforcedMasterPasswordOptions == undefined) {
          this.enforcedMasterPasswordOptions = await firstValueFrom(
            this.policyService.masterPasswordPolicyOptions$()
          );
        }

        if (this.requirePasswordChange()) {
          await this.stateService.setForcePasswordResetReason(
            ForceResetPasswordReason.WeakMasterPassword
          );
          this.router.navigate([this.forcePasswordResetRoute]);
          return;
        }
      } catch (e) {
        // Do not prevent unlock if there is an error evaluating policies
        this.logService.error(e);
      }
    }

    if (this.onSuccessfulSubmit != null) {
      await this.onSuccessfulSubmit();
    } else if (this.router != null) {
      this.router.navigate([this.successRoute]);
    }
  }

  private async load() {
    this.pinStatus = await this.vaultTimeoutSettingsService.isPinLockSet();

    // The loading of the lock component works as follows:
    //   1. First, is locking a valid timeout action?  If not, we will log the user out.
    //   2. If locking IS a valid timeout action, we proceed to show the user the lock screen.
    //      The user will be able to unlock as follows:
    //        - If they have a PIN set, they will be presented with the PIN input
    //        - If they have a master password and no PIN, they will be presented with the master password input
    //        - If they have biometrics enabled, they will be presented with the biometric prompt
    //   Note: The following scenario is currently NOT handled:
    //     - The user has a master password and no PIN
    //     - The user has logged in with Trusted Device Encryption
    //     - The user is offline
    //     - The user locks their vault
    //   This will result in the user not being able to unlock their vault and having to log out.
    let ephemeralPinSet = await this.stateService.getPinKeyEncryptedUserKeyEphemeral();
    ephemeralPinSet ||= await this.stateService.getDecryptedPinProtected();
    this.pinEnabled =
      (this.pinStatus === "TRANSIENT" && !!ephemeralPinSet) || this.pinStatus === "PERSISTANT";
    this.masterPasswordEnabled = await this.userVerificationService.hasMasterPassword();

    this.supportsBiometric = await this.platformUtilsService.supportsBiometric();
    this.biometricLock =
      (await this.vaultTimeoutSettingsService.isBiometricLockSet()) &&
      ((await this.cryptoService.hasUserKeyStored(KeySuffixOptions.Biometric)) ||
        !this.platformUtilsService.supportsSecureStorage());
    this.biometricText = await this.stateService.getBiometricText();
    this.email = await this.stateService.getEmail();

    // TODO: might have to duplicate/extend this check a bit - should it use new AcctDecryptionOptions?
    // if the user has no MP hash via TDE and they get here without biometric / pin as well, they should logout as well.

    const availableVaultTimeoutActions = await firstValueFrom(
      this.vaultTimeoutSettingsService.availableVaultTimeoutActions$()
    );
    const supportsLock = availableVaultTimeoutActions.includes(VaultTimeoutAction.Lock);
    if (!supportsLock) {
      return await this.vaultTimeoutService.logOut();
    }

    const webVaultUrl = this.environmentService.getWebVaultUrl();
    const vaultUrl =
      webVaultUrl === "https://vault.bitwarden.com" ? "https://bitwarden.com" : webVaultUrl;
    this.webVaultHostname = Utils.getHostname(vaultUrl);
  }

  /**
   * Checks if the master password meets the enforced policy requirements
   * If not, returns false
   */
  private requirePasswordChange(): boolean {
    if (
      this.enforcedMasterPasswordOptions == undefined ||
      !this.enforcedMasterPasswordOptions.enforceOnLogin
    ) {
      return false;
    }

    const passwordStrength = this.passwordStrengthService.getPasswordStrength(
      this.masterPassword,
      this.email
    )?.score;

    return !this.policyService.evaluateMasterPassword(
      passwordStrength,
      this.masterPassword,
      this.enforcedMasterPasswordOptions
    );
  }

  /**
   * Creates a new Pin key that encrypts the user key instead of the
   * master key. Clears the old Pin key from state.
   * @param masterPasswordOnRestart True if Master Password on Restart is enabled
   * @param kdf User's KdfType
   * @param kdfConfig User's KdfConfig
   * @param oldPinKey The old Pin key from state (retrieved from different
   * places depending on if Master Password on Restart was enabled)
   * @returns The user key
   */
  private async decryptAndMigrateOldPinKey(
    masterPasswordOnRestart: boolean,
    kdf: KdfType,
    kdfConfig: KdfConfig,
    oldPinKey: EncString
  ): Promise<UserKey> {
    // Decrypt
    const masterKey = await this.cryptoService.decryptMasterKeyWithPin(
      this.pin,
      this.email,
      kdf,
      kdfConfig,
      oldPinKey
    );
    const encUserKey = await this.stateService.getEncryptedCryptoSymmetricKey();
    const userKey = await this.cryptoService.decryptUserKeyWithMasterKey(
      masterKey,
      new EncString(encUserKey)
    );
    // Migrate
    const pinKey = await this.cryptoService.makePinKey(this.pin, this.email, kdf, kdfConfig);
    const pinProtectedKey = await this.cryptoService.encrypt(userKey.key, pinKey);
    if (masterPasswordOnRestart) {
      await this.stateService.setDecryptedPinProtected(null);
      await this.stateService.setPinKeyEncryptedUserKeyEphemeral(pinProtectedKey);
    } else {
      await this.stateService.setEncryptedPinProtected(null);
      await this.stateService.setPinKeyEncryptedUserKey(pinProtectedKey);
      // We previously only set the protected pin if MP on Restart was enabled
      // now we set it regardless
      const encPin = await this.cryptoService.encrypt(this.pin, userKey);
      await this.stateService.setProtectedPin(encPin.encryptedString);
    }
    // This also clears the old Biometrics key since the new Biometrics key will
    // be created when the user key is set.
    await this.stateService.setCryptoMasterKeyBiometric(null);
    return userKey;
  }
}
