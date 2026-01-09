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

  // Track which element's popup is showing (null | 0 | 1)
  const [showOptionsIndex, setShowOptionsIndex] = useState(null);
  const [hoverTimeout, setHoverTimeout] = useState(null);
  const [popupPosition, setPopupPosition] = useState('below'); // 'below' or 'above'

  // Multiple refs (one per element)
  const interactiveRef0 = useRef(null);
  const interactiveRef1 = useRef(null);
  const popupRef0 = useRef(null);
  const popupRef1 = useRef(null);

  // Normalize to array format (supports both old and new formats)
  const interactives = React.useMemo(() => {
    if (typeof suggestion === 'string') return [];

    // New format takes precedence
    if (suggestion.interactives && Array.isArray(suggestion.interactives)) {
      return suggestion.interactives;
    }

    // Backwards compatibility: convert old format
    if (suggestion.interactive) {
      return [suggestion.interactive];
    }

    return [];
  }, [suggestion]);

  // Track updated interactive positions for each element
  const [interactivePositions, setInteractivePositions] = useState(() => {
    return interactives.map(int => ({ start: int.start, end: int.end }));
  });

  // Sync positions when suggestion changes (reset to original positions)
  useEffect(() => {
    setInteractivePositions(interactives.map(int => ({ start: int.start, end: int.end })));
    setCurrentText(typeof suggestion === 'string' ? suggestion : (suggestion.text || ''));
  }, [suggestion, interactives]);

  // Handle click outside to close popup
  useEffect(() => {
    if (showOptionsIndex === null) return;

    const handleClickOutside = (event) => {
      // Check all interactive refs and popup refs
      const clickedInside = [interactiveRef0, interactiveRef1, popupRef0, popupRef1]
        .some(ref => ref.current && ref.current.contains(event.target));

      if (!clickedInside) {
        setShowOptionsIndex(null);
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
  }, [showOptionsIndex, hoverTimeout]);

  // Track popup inline styles for fixed positioning (one per element)
  const [popupStyles, setPopupStyles] = useState([{}, {}]);

  // Calculate popup position to avoid overflow
  useEffect(() => {
    if (showOptionsIndex === null) return;

    const interactiveRef = showOptionsIndex === 0 ? interactiveRef0 : interactiveRef1;
    const popupRef = showOptionsIndex === 0 ? popupRef0 : popupRef1;

    if (!interactiveRef.current || !popupRef.current) return;

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
    setPopupStyles(prev => {
      const updated = [...prev];
      updated[showOptionsIndex] = {
        top: `${top}px`,
        left: `${left}px`
      };
      return updated;
    });
  }, [showOptionsIndex]);

  // Recalculate positions when an element's text length changes
  const recalculatePositions = useCallback((elementIndex, oldLength, newLength) => {
    setInteractivePositions(prev => {
      const newPositions = [...prev];
      const lengthDiff = newLength - oldLength;

      // Get the OLD end position of the changed element
      const oldEnd = prev[elementIndex].end;

      // Update current element's end position
      newPositions[elementIndex] = {
        start: prev[elementIndex].start,
        end: prev[elementIndex].start + newLength
      };

      // Shift ALL elements that come after this one in the TEXT (not array index)
      // Only shift elements whose start position is >= the old end position
      for (let i = 0; i < newPositions.length; i++) {
        if (i !== elementIndex && prev[i].start >= oldEnd) {
          newPositions[i] = {
            start: prev[i].start + lengthDiff,
            end: prev[i].end + lengthDiff
          };
        }
      }

      return newPositions;
    });
  }, []);

  // Handle option selection
  const handleOptionSelect = useCallback((elementIndex, newValue) => {
    if (interactives.length === 0 || !interactivePositions[elementIndex]) return;

    const { start, end } = interactivePositions[elementIndex];
    const oldLength = end - start;
    const newLength = newValue.length;

    // Rebuild text with new value
    const newText = currentText.substring(0, start) + newValue + currentText.substring(end);
    setCurrentText(newText);

    // Recalculate positions (shifts subsequent elements if needed)
    recalculatePositions(elementIndex, oldLength, newLength);

    setShowOptionsIndex(null);

    // Clear hover timeout
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      setHoverTimeout(null);
    }
  }, [interactives, interactivePositions, currentText, hoverTimeout, recalculatePositions]);

  // Handle slider value change
  const handleSliderChange = useCallback((e, elementIndex) => {
    e.stopPropagation(); // Prevent event from bubbling up
    e.preventDefault();

    if (interactives.length === 0 || !interactivePositions[elementIndex]) return;

    const newValue = e.target.value;
    const { start, end } = interactivePositions[elementIndex];
    const valueStr = String(newValue);
    const oldLength = end - start;
    const newLength = valueStr.length;
    const newText = currentText.substring(0, start) + valueStr + currentText.substring(end);

    // Update text
    setCurrentText(newText);

    // Recalculate positions (shifts subsequent elements if needed)
    recalculatePositions(elementIndex, oldLength, newLength);
  }, [interactives, interactivePositions, currentText, recalculatePositions]);

  // Handle year range slider changes (dual-thumb) - one per element
  const [yearRangeValues, setYearRangeValues] = useState(() => {
    return interactives.map(int => {
      if (int.type === 'year-range') {
        return { min: int.minValue, max: int.maxValue };
      }
      return null;
    });
  });

  // Sync yearRangeValues when interactives changes
  useEffect(() => {
    setYearRangeValues(interactives.map(int => {
      if (int.type === 'year-range') {
        return { min: int.minValue, max: int.maxValue };
      }
      return null;
    }));
  }, [interactives]);

  const handleYearRangeChange = useCallback((e, thumb, elementIndex) => {
    e.stopPropagation();
    e.preventDefault();

    const interactive = interactives[elementIndex];
    const position = interactivePositions[elementIndex];
    if (!interactive || !position) return;

    const currentValues = yearRangeValues[elementIndex] || { min: interactive.minValue, max: interactive.maxValue };
    const newValue = parseInt(e.target.value);
    const minGap = 1;

    // Update the appropriate value
    let newMin = currentValues.min;
    let newMax = currentValues.max;

    if (thumb === 'min') {
      // Ensure min doesn't exceed (max - minGap)
      newMin = Math.min(newValue, currentValues.max - minGap);
    } else {
      // Ensure max doesn't go below (min + minGap)
      newMax = Math.max(newValue, currentValues.min + minGap);
    }

    // Update year range values
    setYearRangeValues(prev => {
      const updated = [...prev];
      updated[elementIndex] = { min: newMin, max: newMax };
      return updated;
    });

    // Reconstruct the range text (e.g., "1950 to 1990")
    const originalText = currentText.substring(position.start, position.end);
    let rangeText;

    // Detect the format used in the original text
    if (/\bfrom\s+\d+\s+to\s+\d+\b/i.test(originalText)) {
      rangeText = `from ${newMin} to ${newMax}`;
    } else if (/\bbetween\s+\d+\s+and\s+\d+\b/i.test(originalText)) {
      rangeText = `between ${newMin} and ${newMax}`;
    } else if (/\d+\s*-\s*\d+/.test(originalText)) {
      rangeText = `${newMin}-${newMax}`;
    } else if (/\d+\s+to\s+\d+/i.test(originalText)) {
      rangeText = `${newMin} to ${newMax}`;
    } else {
      rangeText = `${newMin} to ${newMax}`; // default
    }

    const newText = currentText.substring(0, position.start) + rangeText + currentText.substring(position.end);

    // Update text
    setCurrentText(newText);

    // Recalculate positions (shifts subsequent elements if needed)
    recalculatePositions(elementIndex, position.end - position.start, rangeText.length);
  }, [interactives, interactivePositions, currentText, yearRangeValues, recalculatePositions]);

  // Handle mouse enter on interactive element
  const handleMouseEnter = useCallback((elementIndex) => {
    // Small delay before showing options to avoid accidental triggers
    if (hoverTimeout) clearTimeout(hoverTimeout);

    const timeout = setTimeout(() => {
      setShowOptionsIndex(elementIndex);
    }, 200);
    setHoverTimeout(timeout);
  }, [hoverTimeout]);

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
      setShowOptionsIndex(null);
    }, 150);
    setHoverTimeout(timeout);
  }, []);

  // Helper function to render a popup for a specific interactive element
  const renderPopup = (elementIndex, interactive, popupRef) => {
    const { context, options, type, min, max, step, minValue, maxValue } = interactive;
    const position = interactivePositions[elementIndex];
    const interactiveValue = currentText.substring(position.start, position.end);
    const isSlider = type === 'slider';
    const isYearRange = type === 'year-range';

    return (
      <div
        ref={popupRef}
        className={`options-popup ${popupPosition === 'above' ? 'options-popup-above' : ''} ${isSlider || isYearRange ? 'slider-popup' : ''}`}
        style={popupStyles[elementIndex]}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onMouseEnter={() => {
          // Keep popup visible when hovering over it
          if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            setHoverTimeout(null);
          }
          setShowOptionsIndex(elementIndex);
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
                <span className="year-label">{yearRangeValues[elementIndex]?.min || minValue}</span>
                <span className="year-label">{yearRangeValues[elementIndex]?.max || maxValue}</span>
              </div>
              <div className="dual-slider-container">
                {/* Min year slider */}
                <input
                  type="range"
                  min={min || 1900}
                  max={max || 2100}
                  step={step || 1}
                  value={yearRangeValues[elementIndex]?.min || minValue}
                  onChange={(e) => handleYearRangeChange(e, 'min', elementIndex)}
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
                  value={yearRangeValues[elementIndex]?.max || maxValue}
                  onChange={(e) => handleYearRangeChange(e, 'max', elementIndex)}
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
                onChange={(e) => handleSliderChange(e, elementIndex)}
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
                    handleOptionSelect(elementIndex, option);
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
    );
  };

  // Render text with multiple interactive elements
  const renderText = () => {
    if (interactives.length === 0) {
      return <span className="break-words">{currentText}</span>;
    }

    // Sort by start position to handle out-of-order elements
    const sortedIndices = interactives
      .map((_, idx) => idx)
      .sort((a, b) => interactivePositions[a].start - interactivePositions[b].start);

    const segments = [];
    let lastEnd = 0;

    sortedIndices.forEach(elementIndex => {
      const { start, end } = interactivePositions[elementIndex];
      const interactive = interactives[elementIndex];

      // Text before this element
      if (start > lastEnd) {
        segments.push(
          <span key={`text-${elementIndex}`}>
            {currentText.substring(lastEnd, start)}
          </span>
        );
      }

      // Interactive element
      const refToUse = elementIndex === 0 ? interactiveRef0 : interactiveRef1;
      const popupRefToUse = elementIndex === 0 ? popupRef0 : popupRef1;

      segments.push(
        <span
          key={`interactive-${elementIndex}`}
          ref={refToUse}
          className="interactive-value"
          onMouseEnter={() => handleMouseEnter(elementIndex)}
          onMouseLeave={handleMouseLeave}
        >
          {currentText.substring(start, end)}

          {showOptionsIndex === elementIndex && (
            renderPopup(elementIndex, interactive, popupRefToUse)
          )}
        </span>
      );

      lastEnd = end;
    });

    // Remaining text
    if (lastEnd < currentText.length) {
      segments.push(
        <span key="text-final">{currentText.substring(lastEnd)}</span>
      );
    }

    return <span className="break-words">{segments}</span>;
  };

  // Handle button click - ensure we only pass the text string
  const handleButtonClick = useCallback((e) => {
    // Don't trigger if clicking inside the popup
    if (showOptionsIndex !== null) {
      return;
    }

    // Ensure we're passing a clean string
    const textToSubmit = String(currentText);
    console.log('[InteractiveSuggestion] Submitting:', textToSubmit);

    onSubmit(textToSubmit, e);
  }, [showOptionsIndex, currentText, onSubmit]);

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
