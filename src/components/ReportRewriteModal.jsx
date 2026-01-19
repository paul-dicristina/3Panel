import React, { useState, useEffect } from 'react';

/**
 * ReportRewriteModal Component
 *
 * Modal dialog for capturing user preferences for report rewriting
 * Allows users to specify the report objective and writing style via sliders or custom text
 */
const ReportRewriteModal = ({ isOpen, onRewrite, onCancel, isProcessing, persistedCustomStyle, onCustomStyleChange, persistedObjective, onObjectiveChange }) => {
  const [objective, setObjective] = useState('');
  const [styleMode, setStyleMode] = useState('selector'); // 'selector' or 'custom'

  // Slider positions (0-4, where 0 is left, 2 is middle, 4 is right)
  const [casualFormal, setCasualFormal] = useState(2);
  const [accessibleTechnical, setAccessibleTechnical] = useState(2);
  const [briefThorough, setBriefThorough] = useState(2);

  const [customStyleText, setCustomStyleText] = useState('');
  const [showError, setShowError] = useState(false);

  // Initialize customStyleText from persisted value when modal opens
  useEffect(() => {
    if (isOpen && persistedCustomStyle) {
      setCustomStyleText(persistedCustomStyle);
    }
  }, [isOpen, persistedCustomStyle]);

  // Initialize objective from persisted value when modal opens
  useEffect(() => {
    if (isOpen && persistedObjective) {
      setObjective(persistedObjective);
    }
  }, [isOpen, persistedObjective]);

  // Generate style description based on slider positions
  const generateStyleDescription = () => {
    // Map slider values to descriptive terms
    const formalityLevels = ['very casual', 'somewhat casual', 'moderately casual', 'somewhat formal', 'very formal'];
    const technicalityLevels = ['very accessible', 'somewhat accessible', 'moderately accessible', 'somewhat technical', 'very technical'];
    const lengthLevels = ['very brief', 'somewhat brief', 'balanced between brief and thorough', 'somewhat thorough', 'very thorough'];

    const formality = formalityLevels[casualFormal];
    const technicality = technicalityLevels[accessibleTechnical];
    const length = lengthLevels[briefThorough];

    return `Rewrite the report in a ${formality}, ${technicality} style, with an amount of text ${length}.`;
  };

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

    // Use customStyleText if Custom mode, otherwise use generated style description
    const finalStyle = styleMode === 'custom' ? customStyleText.trim() : generateStyleDescription();
    await onRewrite(trimmedObjective, finalStyle);

    // Reset to defaults
    setStyleMode('selector');
    setCasualFormal(2);
    setAccessibleTechnical(2);
    setBriefThorough(2);
  };

  const handleCancel = () => {
    setStyleMode('selector');
    setCasualFormal(2);
    setAccessibleTechnical(2);
    setBriefThorough(2);
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
              const newValue = e.target.value;
              setObjective(newValue);
              onObjectiveChange(newValue);
              if (showError && newValue.trim()) {
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

        {/* Style Mode Selector (centered) */}
        <div className="flex justify-center mb-6">
          <div
            className="relative inline-flex items-center rounded-full"
            style={{
              width: '280px',
              height: '36px',
              backgroundColor: '#dcdce2'
            }}
          >
            {/* Animated selector pill */}
            <div
              className="absolute rounded-full transition-all duration-300 ease-in-out"
              style={{
                width: '136px',
                height: '32px',
                backgroundColor: 'white',
                boxShadow: '0px 1px 3px rgba(0, 0, 0, 0.1)',
                left: styleMode === 'selector' ? '2px' : '142px',
                top: '2px'
              }}
            />
            {/* Buttons */}
            <button
              onClick={() => setStyleMode('selector')}
              disabled={isProcessing}
              className="relative z-10 flex-1 h-full text-sm font-medium transition-colors duration-300"
              style={{
                color: styleMode === 'selector' ? '#111827' : '#6b7280'
              }}
            >
              Style Selector
            </button>
            <button
              onClick={() => setStyleMode('custom')}
              disabled={isProcessing}
              className="relative z-10 flex-1 h-full text-sm font-medium transition-colors duration-300"
              style={{
                color: styleMode === 'custom' ? '#111827' : '#6b7280'
              }}
            >
              Custom Style
            </button>
          </div>
        </div>

        {styleMode === 'selector' ? (
          <>
            {/* Slider Controls */}
            <div className="mb-6 space-y-6">
              {/* Casual - Formal Slider */}
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium text-gray-700 w-24 text-right">Casual</span>
                <input
                  type="range"
                  min="0"
                  max="4"
                  step="1"
                  value={casualFormal}
                  onChange={(e) => setCasualFormal(parseInt(e.target.value))}
                  disabled={isProcessing}
                  className="flex-1 h-1 bg-gray-300 rounded-lg appearance-none cursor-pointer slider-with-detents"
                  style={{
                    background: `linear-gradient(to right, #cbd5e1 0%, #cbd5e1 ${(casualFormal / 4) * 100}%, #e5e7eb ${(casualFormal / 4) * 100}%, #e5e7eb 100%)`
                  }}
                />
                <span className="text-sm font-medium text-gray-700 w-24">Formal</span>
              </div>

              {/* Accessible - Technical Slider */}
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium text-gray-700 w-24 text-right">Accessible</span>
                <input
                  type="range"
                  min="0"
                  max="4"
                  step="1"
                  value={accessibleTechnical}
                  onChange={(e) => setAccessibleTechnical(parseInt(e.target.value))}
                  disabled={isProcessing}
                  className="flex-1 h-1 bg-gray-300 rounded-lg appearance-none cursor-pointer slider-with-detents"
                  style={{
                    background: `linear-gradient(to right, #cbd5e1 0%, #cbd5e1 ${(accessibleTechnical / 4) * 100}%, #e5e7eb ${(accessibleTechnical / 4) * 100}%, #e5e7eb 100%)`
                  }}
                />
                <span className="text-sm font-medium text-gray-700 w-24">Technical</span>
              </div>

              {/* Brief - Thorough Slider */}
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium text-gray-700 w-24 text-right">Brief</span>
                <input
                  type="range"
                  min="0"
                  max="4"
                  step="1"
                  value={briefThorough}
                  onChange={(e) => setBriefThorough(parseInt(e.target.value))}
                  disabled={isProcessing}
                  className="flex-1 h-1 bg-gray-300 rounded-lg appearance-none cursor-pointer slider-with-detents"
                  style={{
                    background: `linear-gradient(to right, #cbd5e1 0%, #cbd5e1 ${(briefThorough / 4) * 100}%, #e5e7eb ${(briefThorough / 4) * 100}%, #e5e7eb 100%)`
                  }}
                />
                <span className="text-sm font-medium text-gray-700 w-24">Thorough</span>
              </div>
            </div>

            {/* Read-only Style Description */}
            <div className="mb-6">
              <div className="w-full px-4 py-3 text-sm bg-gray-100 border border-gray-300 rounded-lg text-gray-600">
                {generateStyleDescription()}
              </div>
            </div>
          </>
        ) : (
          /* Custom Style Text Field */
          <div className="mb-6">
            <textarea
              value={customStyleText}
              onChange={(e) => {
                const newValue = e.target.value;
                setCustomStyleText(newValue);
                onCustomStyleChange(newValue);
              }}
              placeholder="Describe your desired writing style in your own words..."
              rows={8}
              disabled={isProcessing}
              className="w-full px-4 py-3 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3686c1] resize-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>
        )}

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
