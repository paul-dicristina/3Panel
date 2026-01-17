import React, { useEffect } from 'react';

const ExportReportModal = ({ isOpen, onExport, onCancel, isExporting }) => {
  // Handle ESC key to close dialog
  useEffect(() => {
    const handleEscKey = (e) => {
      // Only close on ESC if modal is open and not exporting
      if (e.key === 'Escape' && isOpen && !isExporting) {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleEscKey);
    return () => document.removeEventListener('keydown', handleEscKey);
  }, [isOpen, isExporting, onCancel]);

  if (!isOpen) return null;

  const formatOptions = [
    {
      id: 'html',
      label: 'HTML',
      description: 'Standalone HTML file with embedded visualizations'
    },
    {
      id: 'quarto',
      label: 'Quarto (.qmd)',
      description: 'Reproducible document with full code for RStudio'
    },
    {
      id: 'jupyter',
      label: 'Jupyter Notebook (.ipynb)',
      description: 'Reproducible notebook with R kernel'
    },
    {
      id: 'pdf',
      label: 'PDF',
      description: 'Print to PDF via browser dialog'
    }
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-20 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[500px] max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Export Report</h2>
          <p className="text-sm text-gray-600 mt-1">
            Choose a format to export your analysis report
          </p>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {isExporting ? (
            // Progress state
            <div className="flex flex-col items-center justify-center py-12">
              <img
                src="/animated-diamond-loop.svg"
                alt="Exporting..."
                className="w-16 h-16 mb-4"
              />
              <p className="text-sm text-gray-700">Exporting report...</p>
              <p className="text-xs text-gray-500 mt-1">Please wait</p>
            </div>
          ) : (
            // Format selection buttons
            <div className="space-y-3">
              {formatOptions.map((format) => (
                <button
                  key={format.id}
                  onClick={() => onExport(format.id)}
                  className="w-full text-left px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-colors"
                >
                  <div className="font-medium text-gray-900">{format.label}</div>
                  <div className="text-sm text-gray-600 mt-1">{format.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {!isExporting && (
          <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ExportReportModal;
