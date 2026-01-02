import React, { useState, useEffect, useRef } from 'react';

/**
 * InteractiveSuggestion Component
 *
 * Renders a suggestion with an optional interactive element that shows
 * alternative values on hover. Users can swap values before submitting.
 */
const InteractiveSuggestion = ({ suggestion, iconName, onSubmit }) => {
  // Track current text (may differ from original if user swaps values)
  // IMPORTANT: Ensure this is always a string
  const initialText = typeof suggestion === 'string' ? suggestion : (suggestion.text || '');
  const [currentText, setCurrentText] = useState(String(initialText));
  const [showOptions, setShowOptions] = useState(false);
  const [hoverTimeout, setHoverTimeout] = useState(null);
  const [popupPosition, setPopupPosition] = useState('below'); // 'below' or 'above'
  const interactiveRef = useRef(null);
  const popupRef = useRef(null);

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

  // Handle click outside to close popup
  useEffect(() => {
    if (!showOptions) return;

    const handleClickOutside = (event) => {
      if (
        interactiveRef.current &&
        !interactiveRef.current.contains(event.target) &&
        popupRef.current &&
        !popupRef.current.contains(event.target)
      ) {
        setShowOptions(false);
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
          setHoverTimeout(null);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showOptions, hoverTimeout]);

  // Calculate popup position to avoid overflow
  useEffect(() => {
    if (!showOptions || !interactiveRef.current || !popupRef.current) return;

    const interactiveRect = interactiveRef.current.getBoundingClientRect();
    const popupRect = popupRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    // Check if popup would overflow below
    const spaceBelow = viewportHeight - interactiveRect.bottom;
    const spaceAbove = interactiveRect.top;

    // If not enough space below but more space above, position above
    if (spaceBelow < popupRect.height && spaceAbove > spaceBelow) {
      setPopupPosition('above');
    } else {
      setPopupPosition('below');
    }
  }, [showOptions]);

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

  // Handle slider value change
  const handleSliderChange = (e) => {
    e.stopPropagation(); // Prevent event from bubbling up
    e.preventDefault();

    if (!interactive || !interactivePositions) return;

    const newValue = e.target.value;
    const { start, end } = interactivePositions;
    const valueStr = String(newValue);
    const newText = currentText.substring(0, start) + valueStr + currentText.substring(end);

    // Update text
    setCurrentText(newText);

    // Recalculate positions for the new value
    setInteractivePositions({
      start: start,
      end: start + valueStr.length
    });
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
    const { context, options, type, min, max, step } = interactive;
    const before = currentText.substring(0, start);
    const interactiveValue = currentText.substring(start, end);
    const after = currentText.substring(end);

    const isSlider = type === 'slider';

    return (
      <span className="break-words">
        {before}
        <span
          ref={interactiveRef}
          className="interactive-value"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {interactiveValue}
          {showOptions && (
            <div
              ref={popupRef}
              className={`options-popup ${popupPosition === 'above' ? 'options-popup-above' : ''} ${isSlider ? 'slider-popup' : ''}`}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
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
              {isSlider ? (
                // Slider UI
                <div
                  className="slider-container"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="slider-header">{context}</div>
                  <div className="slider-control">
                    <input
                      type="range"
                      min={min || 1}
                      max={max || 100}
                      step={step || 1}
                      value={parseInt(interactiveValue) || min || 1}
                      onChange={handleSliderChange}
                      onMouseDown={(e) => e.stopPropagation()}
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      className="slider-input"
                    />
                    <div className="slider-value">{interactiveValue}</div>
                  </div>
                </div>
              ) : (
                // Options list UI
                <>
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
                </>
              )}
            </div>
          )}
        </span>
        {after}
      </span>
    );
  };

  // Handle button click - ensure we only pass the text string
  const handleButtonClick = (e) => {
    // Don't trigger if clicking inside the popup
    if (showOptions) {
      return;
    }

    // Ensure we're passing a clean string
    const textToSubmit = String(currentText);
    console.log('[InteractiveSuggestion] Submitting:', textToSubmit);

    onSubmit(textToSubmit, e);
  };

  return (
    <button
      onClick={handleButtonClick}
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
