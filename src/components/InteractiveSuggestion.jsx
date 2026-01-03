import React, { useState, useEffect, useRef, useCallback } from 'react';

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

  // Track popup inline styles for fixed positioning
  const [popupStyles, setPopupStyles] = useState({});

  // Calculate popup position to avoid overflow
  useEffect(() => {
    if (!showOptions || !interactiveRef.current || !popupRef.current) return;

    const interactiveRect = interactiveRef.current.getBoundingClientRect();
    const popupRect = popupRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Check if popup would overflow below
    const spaceBelow = viewportHeight - interactiveRect.bottom;
    const spaceAbove = interactiveRect.top;

    // Calculate position
    let top, left;
    let position;

    if (spaceBelow < popupRect.height && spaceAbove > spaceBelow) {
      // Position above
      top = interactiveRect.top - popupRect.height - 4;
      position = 'above';
    } else {
      // Position below
      top = interactiveRect.bottom + 4;
      position = 'below';
    }

    // Center horizontally on the interactive element
    left = interactiveRect.left + (interactiveRect.width / 2) - (popupRect.width / 2);

    // Ensure popup stays within viewport horizontally
    if (left < 8) left = 8;
    if (left + popupRect.width > viewportWidth - 8) {
      left = viewportWidth - popupRect.width - 8;
    }

    // Ensure popup stays within viewport vertically
    if (top < 8) top = 8;
    if (top + popupRect.height > viewportHeight - 8) {
      top = viewportHeight - popupRect.height - 8;
    }

    setPopupPosition(position);
    setPopupStyles({
      top: `${top}px`,
      left: `${left}px`
    });
  }, [showOptions]);

  // Handle option selection
  const handleOptionSelect = useCallback((newValue) => {
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
  }, [interactive, interactivePositions, currentText, hoverTimeout]);

  // Handle slider value change
  const handleSliderChange = useCallback((e) => {
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
  }, [interactive, interactivePositions, currentText]);

  // Handle year range slider changes (dual-thumb)
  const [yearRangeValues, setYearRangeValues] = useState(() => {
    if (interactive && interactive.type === 'year-range') {
      return { min: interactive.minValue, max: interactive.maxValue };
    }
    return null;
  });

  // Sync yearRangeValues when interactive changes
  useEffect(() => {
    if (interactive && interactive.type === 'year-range') {
      setYearRangeValues({ min: interactive.minValue, max: interactive.maxValue });
    }
  }, [interactive]);

  const handleYearRangeChange = useCallback((e, thumb) => {
    e.stopPropagation();
    e.preventDefault();

    if (!interactive || !interactivePositions || !yearRangeValues) return;

    const newValue = parseInt(e.target.value);
    const { start, end } = interactivePositions;

    // Update the appropriate value
    let newMin = yearRangeValues.min;
    let newMax = yearRangeValues.max;

    if (thumb === 'min') {
      newMin = Math.min(newValue, yearRangeValues.max); // Ensure min <= max
    } else {
      newMax = Math.max(newValue, yearRangeValues.min); // Ensure max >= min
    }

    setYearRangeValues({ min: newMin, max: newMax });

    // Reconstruct the range text (e.g., "1950 to 1990")
    const originalText = currentText.substring(start, end);
    let rangeText;

    // Detect the format used in the original text
    if (/\bfrom\s+\d{4}\s+to\s+\d{4}\b/i.test(originalText)) {
      rangeText = `from ${newMin} to ${newMax}`;
    } else if (/\bbetween\s+\d{4}\s+and\s+\d{4}\b/i.test(originalText)) {
      rangeText = `between ${newMin} and ${newMax}`;
    } else if (/\d{4}\s*-\s*\d{4}/.test(originalText)) {
      rangeText = `${newMin}-${newMax}`;
    } else if (/\d{4}\s+to\s+\d{4}/i.test(originalText)) {
      rangeText = `${newMin} to ${newMax}`;
    } else {
      rangeText = `${newMin} to ${newMax}`; // default
    }

    const newText = currentText.substring(0, start) + rangeText + currentText.substring(end);

    // Update text
    setCurrentText(newText);

    // Recalculate positions for the new range text
    setInteractivePositions({
      start: start,
      end: start + rangeText.length
    });
  }, [interactive, interactivePositions, currentText, yearRangeValues]);

  // Handle mouse enter on interactive element
  const handleMouseEnter = useCallback(() => {
    // Small delay before showing options to avoid accidental triggers
    const timeout = setTimeout(() => {
      setShowOptions(true);
    }, 200);
    setHoverTimeout(timeout);
  }, []);

  // Handle mouse leave from interactive element
  const handleMouseLeave = useCallback(() => {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      setHoverTimeout(null);
    }
    // Don't auto-close - let the popup's own mouseleave handle it
  }, [hoverTimeout]);

  // Handle mouse leave from popup
  const handlePopupMouseLeave = useCallback(() => {
    // Close after a short delay to allow moving between options
    const timeout = setTimeout(() => {
      setShowOptions(false);
    }, 150);
    setHoverTimeout(timeout);
  }, []);

  // Render text with interactive element
  const renderText = () => {
    if (!interactive || !interactivePositions) {
      return <span className="break-words">{currentText}</span>;
    }

    const { start, end } = interactivePositions;
    const { context, options, type, min, max, step, minValue, maxValue } = interactive;
    const before = currentText.substring(0, start);
    const interactiveValue = currentText.substring(start, end);
    const after = currentText.substring(end);

    const isSlider = type === 'slider';
    const isYearRange = type === 'year-range';

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
              className={`options-popup ${popupPosition === 'above' ? 'options-popup-above' : ''} ${isSlider || isYearRange ? 'slider-popup' : ''}`}
              style={popupStyles}
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
              {isYearRange ? (
                // Year Range Slider UI (dual-thumb)
                <div
                  className="slider-container"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="slider-header">{context}</div>
                  <div className="year-range-control">
                    <div className="year-range-labels">
                      <span className="year-label">{yearRangeValues?.min || minValue}</span>
                      <span className="year-label">{yearRangeValues?.max || maxValue}</span>
                    </div>
                    <div className="dual-slider-container">
                      {/* Min year slider */}
                      <input
                        type="range"
                        min={min || 1900}
                        max={max || 2100}
                        step={step || 1}
                        value={yearRangeValues?.min || minValue}
                        onChange={(e) => handleYearRangeChange(e, 'min')}
                        onMouseDown={(e) => e.stopPropagation()}
                        onMouseUp={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        className="slider-input range-min"
                      />
                      {/* Max year slider */}
                      <input
                        type="range"
                        min={min || 1900}
                        max={max || 2100}
                        step={step || 1}
                        value={yearRangeValues?.max || maxValue}
                        onChange={(e) => handleYearRangeChange(e, 'max')}
                        onMouseDown={(e) => e.stopPropagation()}
                        onMouseUp={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        className="slider-input range-max"
                      />
                    </div>
                  </div>
                </div>
              ) : isSlider ? (
                // Single Slider UI
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
  const handleButtonClick = useCallback((e) => {
    // Don't trigger if clicking inside the popup
    if (showOptions) {
      return;
    }

    // Ensure we're passing a clean string
    const textToSubmit = String(currentText);
    console.log('[InteractiveSuggestion] Submitting:', textToSubmit);

    onSubmit(textToSubmit, e);
  }, [showOptions, currentText, onSubmit]);

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
