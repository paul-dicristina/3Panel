import React, { useState, useEffect } from 'react';

/**
 * ReportRewriteModal Component
 *
 * Modal dialog for capturing user preferences for report rewriting
 * Allows users to specify the report objective and writing style
 */
const ReportRewriteModal = ({ isOpen, onRewrite, onCancel, isProcessing }) => {
  const [objective, setObjective] = useState('');
  const [style, setStyle] = useState('Formal & Technical');
  const [customStyle, setCustomStyle] = useState('');
  const [showError, setShowError] = useState(false);

  const styleOptions = [
    'Formal & Technical',
    'Casual & Technical',
    'Brief & Focused',
    'Formal & Accessible',
    'Casual & Accessible',
    'Detailed & Thorough',
    'Custom'
  ];

  // Handle ESC key to close modal
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!isOpen || isProcessing) return;

      if (event.key === 'Escape') {
        handleCancel();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, isProcessing]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    const trimmedObjective = objective.trim();

    if (!trimmedObjective) {
      setShowError(true);
      return;
    }

    setShowError(false);

    // Use customStyle if Custom is selected, otherwise use the selected style
    const finalStyle = style === 'Custom' ? customStyle.trim() : style;
    await onRewrite(trimmedObjective, finalStyle);

    // Reset form
    setObjective('');
    setStyle('Formal & Technical');
    setCustomStyle('');
  };

  const handleCancel = () => {
    setObjective('');
    setStyle('Formal & Technical');
    setCustomStyle('');
    setShowError(false);
    onCancel();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-20 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-[600px]">
        <h2 className="text-2xl font-bold mb-2 text-gray-800">
          Rewrite Report
        </h2>
        <p className="text-gray-600 mb-6 text-sm">
          Positronic will reorganize and restyle your report based on your objectives
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
            className={`w-full px-4 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3686c1] resize-none ${
              showError ? 'border-red-500' : 'border-gray-300'
            }`}
            disabled={isProcessing}
            autoFocus
          />
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
          <div className="relative">
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              disabled={isProcessing}
              className="w-full px-4 py-2 pr-10 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3686c1] disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
            >
              {styleOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {/* Custom chevron icon */}
            <div className="absolute inset-y-0 right-[8px] flex items-center pointer-events-none">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>

          {/* Custom Style Input - shown only when Custom is selected */}
          {style === 'Custom' && (
            <textarea
              value={customStyle}
              onChange={(e) => setCustomStyle(e.target.value)}
              placeholder=""
              rows={6}
              disabled={isProcessing}
              className="mt-3 w-full px-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3686c1] resize-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-3">
          <button
            onClick={handleCancel}
            disabled={isProcessing}
            className="w-24 h-8 px-4 bg-white border border-gray-300 rounded-md hover:bg-gray-100 flex items-center justify-center text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isProcessing}
            className="px-4 h-8 text-sm bg-[#3686c1] text-white font-medium rounded-md hover:bg-[#2a6a9a] disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
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
