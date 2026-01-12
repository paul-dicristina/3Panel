import React from 'react';

/**
 * StorageWarningModal Component
 *
 * Modal dialog shown when localStorage quota is exceeded
 * Offers options to clear conversation or continue without saving
 */
const StorageWarningModal = ({ isOpen, onClearAndContinue, onDismiss }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
        <div className="flex items-start mb-4">
          <div className="flex-shrink-0">
            <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="ml-3">
            <h2 className="text-xl font-bold text-gray-900">
              Storage Quota Exceeded
            </h2>
          </div>
        </div>

        <p className="text-gray-700 mb-4 text-sm leading-relaxed">
          Your conversation has grown too large to save to local storage. This can happen when you've generated many plots or have a very long conversation history.
        </p>

        <p className="text-gray-700 mb-6 text-sm leading-relaxed">
          You can either:
        </p>

        <ul className="text-gray-700 mb-6 text-sm space-y-2 ml-4">
          <li className="flex items-start">
            <span className="mr-2">•</span>
            <span><strong>Clear conversation:</strong> Start fresh and free up space (your current conversation will be lost)</span>
          </li>
          <li className="flex items-start">
            <span className="mr-2">•</span>
            <span><strong>Continue without saving:</strong> Keep working but your conversation won't persist across page reloads</span>
          </li>
        </ul>

        <div className="flex justify-end gap-3">
          <button
            onClick={onDismiss}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium rounded-lg hover:bg-gray-100 transition-colors"
          >
            Continue Without Saving
          </button>
          <button
            onClick={onClearAndContinue}
            className="px-4 py-2 bg-amber-600 text-white font-medium rounded-lg hover:bg-amber-700 transition-colors"
          >
            Clear Conversation
          </button>
        </div>
      </div>
    </div>
  );
};

export default StorageWarningModal;
