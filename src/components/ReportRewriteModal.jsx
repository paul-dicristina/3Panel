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
  const [showError, setShowError] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(null);

  const styleOptions = [
    'Formal & Technical',
    'Casual & Technical',
    'Brief & Focused',
    'Formal & Accessible',
    'Casual & Accessible',
    'Detailed & Thorough'
  ];

  // Handle keyboard navigation for style selector
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!isOpen || isProcessing) return;

      // ESC to close modal
      if (event.key === 'Escape') {
        setObjective('');
        setStyle('Formal & Technical');
        setShowError(false);
        setFocusedIndex(null);
        onCancel();
        return;
      }

      // Only handle arrow keys and Enter/Space if a style button has focus
      if (focusedIndex === null) return;

      const gridCols = 3;
      const totalOptions = styleOptions.length;

      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault();
          setFocusedIndex((focusedIndex + 1) % totalOptions);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          setFocusedIndex((focusedIndex - 1 + totalOptions) % totalOptions);
          break;
        case 'ArrowDown':
          event.preventDefault();
          setFocusedIndex((focusedIndex + gridCols) % totalOptions);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setFocusedIndex((focusedIndex - gridCols + totalOptions) % totalOptions);
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          setStyle(styleOptions[focusedIndex]);
          break;
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, isProcessing, focusedIndex, onCancel, styleOptions]);

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
          <div className="border border-gray-300 rounded-lg overflow-hidden">
            <div className="grid grid-cols-3">
              {styleOptions.map((option, index) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setStyle(option);
                    setFocusedIndex(index);
                  }}
                  onFocus={() => setFocusedIndex(index)}
                  onBlur={() => setFocusedIndex(null)}
                  disabled={isProcessing}
                  className={`
                    text-[13px] py-3 px-4
                    ${index < 3 ? 'border-b border-gray-300' : ''}
                    ${index % 3 !== 2 ? 'border-r border-gray-300' : ''}
                    ${style === option
                      ? 'bg-[#3686c1] text-white font-bold'
                      : 'bg-white text-gray-700 hover:bg-gray-50'
                    }
                    ${focusedIndex === index && style !== option
                      ? 'ring-2 ring-inset ring-[#3686c1]'
                      : ''
                    }
                    disabled:opacity-50 disabled:cursor-not-allowed
                    transition-colors
                    focus:outline-none
                  `}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
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
