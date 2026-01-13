import React, { useState } from 'react';

/**
 * ReportRewriteModal Component
 *
 * Modal dialog for capturing user preferences for report rewriting
 * Allows users to specify the report objective and writing style
 */
const ReportRewriteModal = ({ isOpen, onRewrite, onCancel, isProcessing }) => {
  const [objective, setObjective] = useState('');
  const [style, setStyle] = useState('Formal & Technical');
  const [showError, setShowError] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    const trimmedObjective = objective.trim();

    if (!trimmedObjective) {
      setShowError(true);
      return;
    }

    setShowError(false);
    await onRewrite(trimmedObjective, style);

    // Reset form
    setObjective('');
    setStyle('Formal & Technical');
  };

  const handleCancel = () => {
    setObjective('');
    setStyle('Formal & Technical');
    setShowError(false);
    onCancel();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-[500px]">
        <h2 className="text-2xl font-bold mb-2 text-gray-800">
          Rewrite Report
        </h2>
        <p className="text-gray-600 mb-6 text-sm">
          Claude will reorganize and restyle your report based on your objective
        </p>

        {/* Report Objective */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            What is the purpose of this report?
          </label>
          <textarea
            value={objective}
            onChange={(e) => {
              setObjective(e.target.value);
              if (showError && e.target.value.trim()) {
                setShowError(false);
              }
            }}
            placeholder="e.g., Executive summary for stakeholders, Technical analysis for data scientists"
            rows={3}
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none ${
              showError ? 'border-red-500' : 'border-gray-300'
            }`}
            disabled={isProcessing}
            autoFocus
          />
          <p className="mt-1 text-xs text-gray-500">
            Describe who will read this and what they need to know
          </p>
          {showError && (
            <p className="mt-1 text-xs text-red-600">
              Please enter a report objective
            </p>
          )}
        </div>

        {/* Writing Style */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Writing Style
          </label>
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isProcessing}
          >
            <option value="Formal & Technical">Formal &amp; Technical</option>
            <option value="Formal & Accessible">Formal &amp; Accessible</option>
            <option value="Casual & Technical">Casual &amp; Technical</option>
            <option value="Casual & Accessible">Casual &amp; Accessible</option>
            <option value="Brief & Focused">Brief &amp; Focused</option>
            <option value="Detailed & Comprehensive">Detailed &amp; Comprehensive</option>
          </select>
          <p className="mt-1 text-xs text-gray-500">
            Choose the tone and depth appropriate for your audience
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-3">
          <button
            onClick={handleCancel}
            disabled={isProcessing}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isProcessing}
            className="px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isProcessing ? (
              <>
                <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>Rewriting...</span>
              </>
            ) : (
              'Rewrite Report'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReportRewriteModal;
