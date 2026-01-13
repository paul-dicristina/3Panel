// Persistence utility functions for 3Panel conversation state
// Handles localStorage save/load/clear with size optimization

export const PERSISTENCE_CONFIG = {
  STORAGE_KEY: '3panel_conversation_state',
  VERSION: '1.0',
  SAVE_DEBOUNCE_MS: 2000,
  MAX_SIZE_BYTES: 4 * 1024 * 1024,  // 4MB threshold for optimization
  STORAGE_LIMIT_ESTIMATE: 5 * 1024 * 1024  // 5MB conservative estimate
};

/**
 * Calculate the serialized size of data in bytes
 * @param {any} data - Data to measure
 * @returns {number} Size in bytes
 */
export function getStorageSize(data) {
  return new Blob([JSON.stringify(data)]).size;
}

/**
 * Format bytes to human-readable string
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string (e.g., "1.5 MB")
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Estimate remaining localStorage space
 * @returns {number} Estimated remaining space in bytes
 */
export function estimateRemainingSpace() {
  try {
    const used = new Blob([JSON.stringify(localStorage)]).size;
    return PERSISTENCE_CONFIG.STORAGE_LIMIT_ESTIMATE - used;
  } catch (error) {
    console.error('[PERSIST] Error estimating space:', error);
    return 0;
  }
}

/**
 * Strip large PNG data from code cards to reduce size
 * Keeps SVG data which is much smaller (~10-30KB vs 100-500KB)
 * @param {Array} codeCards - Array of code card objects
 * @returns {Array} Optimized code cards without PNG data
 */
export function optimizeCodeCards(codeCards) {
  return codeCards.map(card => ({
    ...card,
    output: card.output ? {
      ...card.output,
      plots: card.output.plots?.map(plot => ({
        ...plot,
        pngBase64: undefined  // Remove large PNG data, keep SVG
      }))
    } : null
  }));
}

/**
 * Generate a simple hash of an object for change detection
 * @param {any} obj - Object to hash
 * @returns {number} Hash value
 */
export function hashObject(obj) {
  const str = JSON.stringify(obj);
  return str.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
}

/**
 * Serialize state object to save to localStorage
 * Converts Sets to Arrays and handles special types
 * @param {Object} state - State object to serialize
 * @returns {Object} Serialized state
 */
export function serializeState(state) {
  return {
    ...state,
    favoritedCardIds: Array.from(state.favoritedCardIds || []),
    expandedSuggestions: Array.from(state.expandedSuggestions || [])
  };
}

/**
 * Deserialize state object from localStorage
 * Converts Arrays back to Sets and validates structure
 * @param {Object} state - Serialized state object
 * @returns {Object} Deserialized state with Sets restored
 */
export function deserializeState(state) {
  return {
    ...state,
    favoritedCardIds: new Set(state.favoritedCardIds || []),
    expandedSuggestions: new Set(state.expandedSuggestions || [])
  };
}

/**
 * Validate that state object has expected structure
 * @param {Object} state - State object to validate
 * @returns {boolean} True if valid
 */
export function validateState(state) {
  if (!state || typeof state !== 'object') return false;

  // Check for required fields with correct types
  if (!Array.isArray(state.messages)) return false;
  if (!Array.isArray(state.codeCards)) return false;

  // Optional fields can be missing, but if present must be correct type
  if (state.reportTitle !== undefined && typeof state.reportTitle !== 'string') return false;
  if (state.reportDescription !== undefined && typeof state.reportDescription !== 'string') return false;
  if (state.favoritedCardIds !== undefined && !Array.isArray(state.favoritedCardIds)) return false;
  if (state.favoritedOutputDescriptions !== undefined && typeof state.favoritedOutputDescriptions !== 'object') return false;
  if (state.favoritedOutputHeadings !== undefined && typeof state.favoritedOutputHeadings !== 'object') return false;
  if (state.reportHistory !== undefined && !Array.isArray(state.reportHistory)) return false;
  if (state.datasetRegistry !== undefined && typeof state.datasetRegistry !== 'object') return false;
  if (state.viewMode !== undefined && typeof state.viewMode !== 'string') return false;
  if (state.expandedSuggestions !== undefined && !Array.isArray(state.expandedSuggestions)) return false;

  return true;
}

/**
 * Get safe default values for state fields
 * Used when loading fails or fields are missing
 * @returns {Object} Default state object
 */
export function getDefaultState() {
  return {
    messages: [],
    codeCards: [],
    reportTitle: '',
    reportDescription: '',
    favoritedCardIds: new Set(),
    favoritedOutputDescriptions: {},
    favoritedOutputHeadings: {},
    reportHistory: [],
    datasetRegistry: { activeDataset: null, datasets: {} },
    viewMode: 'explore',
    selectedCardId: null,
    expandedSuggestions: new Set()
  };
}
