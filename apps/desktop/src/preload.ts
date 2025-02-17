// import { contextBridge } from "electron";
import platform from "./platform/preload";

/**
 * Bitwarden Preload script.
 *
 * This file contains the "glue" between the main process and the renderer process. Please ensure
 * that you have read through the following articles before modifying any preload script.
 *
 * https://www.electronjs.org/docs/latest/tutorial/tutorial-preload
 * https://www.electronjs.org/docs/latest/api/context-bridge
 */

// Each team owns a subspace of the `ipc` global variable in the renderer.
export const ipc = {
  platform,
};

// contextBridge.exposeInMainWorld("ipc", ipc);
