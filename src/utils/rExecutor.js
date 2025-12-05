/**
 * R Code Executor Module - BACKEND R EXECUTION
 *
 * Executes actual R code via backend API
 * The backend runs R code using the system's R installation
 */

const R_API_URL = 'http://localhost:3001/api/execute-r';

/**
 * Execute R code via backend and return the output
 * @param {string} code - The R code to execute
 * @param {boolean} autoFormatTabular - Whether to auto-format tabular data with gt
 * @returns {Promise<Object>} Result containing output, plots, and any errors
 */
export async function executeRCode(code, autoFormatTabular = true) {
  try {
    console.log('Executing R code via backend:', code.substring(0, 100) + '...');
    console.log('Auto format tabular:', autoFormatTabular);

    const response = await fetch(R_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code, autoFormatTabular }),
    });

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log('R execution result:', result);

    return result;
  } catch (error) {
    console.error('Error executing R code:', error);
    return {
      output: '',
      plots: [],
      tables: [],
      error: error.message || 'An error occurred while executing R code'
    };
  }
}

/**
 * No initialization needed for backend execution
 * This function exists for compatibility with App.jsx
 */
export async function initializeWebR() {
  // Backend execution doesn't require initialization
  return Promise.resolve();
}

/**
 * Check if R is ready (always true for backend execution)
 * @returns {boolean} Always true
 */
export function isWebRInitialized() {
  return true;
}
