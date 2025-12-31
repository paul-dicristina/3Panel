import React, { useState } from 'react';

/**
 * InteractiveSuggestion Component
 *
 * Renders a suggestion with an optional interactive element that shows
 * alternative values on hover. Users can swap values before submitting.
 */
const InteractiveSuggestion = ({ suggestion, iconName, onSubmit }) => {
  // Track current text (may differ from original if user swaps values)
  const [currentText, setCurrentText] = useState(suggestion.text || suggestion);
  const [showOptions, setShowOptions] = useState(false);
  const [hoverTimeout, setHoverTimeout] = useState(null);

  // Handle backward compatibility - suggestion might be a string
  const isInteractive = typeof suggestion === 'object' && suggestion.interactive;
  const interactive = isInteractive ? suggestion.interactive : null;

  // Track updated interactive positions
  const [interactivePositions, setInteractivePositions] = useState(() => {
    if (isInteractive && interactive) {
      return { start: interactive.start, end: interactive.end };
    }
    return null;
  });

  // Handle option selection
  const handleOptionSelect = (newValue) => {
    if (!interactive || !interactivePositions) return;

    const { start, end } = interactivePositions;
    const newText = currentText.substring(0, start) + newValue + currentText.substring(end);

    // Update text
    setCurrentText(newText);

    // Recalculate positions for the new value
    setInteractivePositions({
      start: start,
      end: start + newValue.length
    });

    setShowOptions(false);

    // Clear hover timeout
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      setHoverTimeout(null);
    }
  };

  // Handle mouse enter on interactive element
  const handleMouseEnter = () => {
    // Small delay before showing options to avoid accidental triggers
    const timeout = setTimeout(() => {
      setShowOptions(true);
    }, 200);
    setHoverTimeout(timeout);
  };

  // Handle mouse leave from interactive element
  const handleMouseLeave = () => {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      setHoverTimeout(null);
    }
    // Don't auto-close - let the popup's own mouseleave handle it
  };

  // Handle mouse leave from popup
  const handlePopupMouseLeave = () => {
    // Close after a short delay to allow moving between options
    const timeout = setTimeout(() => {
      setShowOptions(false);
    }, 150);
    setHoverTimeout(timeout);
  };

  // Render text with interactive element
  const renderText = () => {
    if (!interactive || !interactivePositions) {
      return <span className="break-words">{currentText}</span>;
    }

    const { start, end } = interactivePositions;
    const { context, options } = interactive;
    const before = currentText.substring(0, start);
    const interactiveValue = currentText.substring(start, end);
    const after = currentText.substring(end);

    return (
      <span className="break-words">
        {before}
        <span
          className="interactive-value"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {interactiveValue}
          {showOptions && (
            <div
              className="options-popup"
              onMouseEnter={() => {
                // Keep popup visible when hovering over it
                if (hoverTimeout) {
                  clearTimeout(hoverTimeout);
                  setHoverTimeout(null);
                }
                setShowOptions(true);
              }}
              onMouseLeave={handlePopupMouseLeave}
            >
              <div className="options-header">{context}</div>
              <div className="options-list">
                {options.map((option, idx) => (
                  <div
                    key={idx}
                    className={`option-item ${option === interactiveValue ? 'selected' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOptionSelect(option);
                    }}
                  >
                    {option}
                    {option === interactiveValue && <span className="checkmark">✓</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </span>
        {after}
      </span>
    );
  };

  return (
    <button
      onClick={(e) => onSubmit(currentText, e)}
      className="suggestion-button flex items-start gap-2 text-left text-blue-600 hover:text-blue-800 hover:underline cursor-pointer p-2"
    >
      <img
        src={`/${iconName}.svg`}
        alt={iconName}
        className="w-8 h-8 flex-shrink-0"
      />
      {renderText()}
    </button>
  );
};

export default InteractiveSuggestion;
