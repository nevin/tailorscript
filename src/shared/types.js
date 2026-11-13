// Shapes of the data Tailorscript keeps, for the type checker (npm run typecheck). This module has no runtime code.

/** @typedef {import("./userscript.js").Metadata} Metadata */

/**
 * @typedef {object} HistoryEntry
 * @property {string} source
 * @property {number} savedAt
 * @property {string} [label]
 */

/**
 * @typedef {object} PendingUpdate
 * @property {string} source
 * @property {string} version
 * @property {string[]} reasons
 * @property {number} foundAt
 */

/**
 * @typedef {object} UpdateCheck
 * @property {number} at
 * @property {string} [latest]
 * @property {string} [skipped]
 * @property {string} [error]
 */

/**
 * @typedef {object} Script
 * @property {string} id
 * @property {string} name
 * @property {string} source
 * @property {boolean} enabled
 * @property {HistoryEntry[]} [history]
 * @property {number} [updatedAt]
 * @property {string} [installUrl]
 * @property {string} [installedHash]
 * @property {boolean} [autoUpdate]
 * @property {UpdateCheck} [updateCheck]
 * @property {PendingUpdate} [pendingUpdate]
 */

/** @typedef {Script & { deletedAt: number }} TrashedScript */

/**
 * @typedef {object} Settings
 * @property {boolean} [paused]
 * @property {boolean} [reloadAfterSave]
 * @property {boolean} [syncBackup]
 * @property {number} [lastExportAt]
 */

/**
 * @typedef {object} Deps Downloaded @require and @resource files for one script.
 * @property {{ url: string, code: string }[]} [requires]
 * @property {{ name: string, url: string, dataUrl: string }[]} [resources]
 * @property {string} [error]
 */

/**
 * @typedef {object} RegistrationState
 * @property {string[]} active
 * @property {string[]} manual
 * @property {Record<string, string>} issues
 * @property {boolean} [setupNeeded]
 * @property {string} [error]
 * @property {string} [installedId]
 */

/**
 * @typedef {object} RunError
 * @property {string} message
 * @property {number} line
 * @property {number} column
 * @property {number} at
 */

/**
 * @typedef {object} TabState Scripts that ran in a tab's current document, and their menu commands.
 * @property {Record<string, { at?: number, url?: string, error?: RunError }>} scripts
 * @property {Record<string, { commandId: string, caption: string, frameId: number, documentId?: string }[]>} menus
 * @property {number} startedAt
 * @property {string} [documentId]
 */

/**
 * chrome.storage.local, layout version 2 (see storage.js).
 * @typedef {{
 *   schemaVersion?: number,
 *   scriptOrder?: string[],
 *   scripts?: Script[],
 *   settings?: Settings,
 *   trash?: TrashedScript[],
 *   syncState?: { at: number, error?: string },
 *   bridgeSecret?: string,
 *   [key: `script:${string}`]: Script,
 *   [key: `deps:${string}`]: Deps,
 *   [key: `values:${string}`]: Record<string, unknown>
 * }} LocalStore
 */

/**
 * chrome.storage.session: state that lasts until the browser closes.
 * @typedef {{
 *   registrationState?: RegistrationState,
 *   runs?: Record<string, { at?: number, url?: string, error?: RunError }>,
 *   tabRuns?: Record<string, TabState>,
 *   notifications?: Record<string, { scriptId: string, callbackId: string, tabId: number, documentId?: string, frameId?: number, highlight: boolean }>,
 *   openedTabs?: Record<string, string>,
 *   diagnosticUrl?: string,
 *   showDiagnostics?: boolean,
 *   focusScript?: string,
 *   focusMessage?: string,
 *   newScriptSite?: string,
 *   pendingEnable?: { id: string, at: number },
 *   newScriptSource?: string
 * }} SessionStore
 */

export {};
