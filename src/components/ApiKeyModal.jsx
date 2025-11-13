import React, { useState } from 'react';

/**
 * ApiKeyModal Component
 *
 * Modal dialog for entering and storing the Anthropic API key
 * Appears on first launch or when user needs to update the key
 */
const ApiKeyModal = ({ isOpen, onSave, onCancel }) => {
  const [apiKey, setApiKey] = useState('');

  if (!isOpen) return null;

  const handleSave = () => {
    if (apiKey.trim()) {
      onSave(apiKey.trim());
      setApiKey('');
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSave();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
        <h2 className="text-2xl font-bold mb-4 text-gray-800">
          Enter Anthropic API Key
        </h2>
        <p className="text-gray-600 mb-4 text-sm">
          Your API key will be stored locally in your browser and used to communicate with Claude.
        </p>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="sk-ant-..."
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
          autoFocus
        />
        <div className="flex justify-end gap-3">
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium rounded-lg hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!apiKey.trim()}
            className="px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};

export default ApiKeyModal;
