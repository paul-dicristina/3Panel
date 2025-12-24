import React from 'react';

/**
 * CodeCard Component
 *
 * Displays a clickable card representing a generated R code snippet
 * - Shows a summary of the code with an appropriate icon
 * - Uses chart-cc.png for chart generation code, code-cc.png otherwise
 * - Blue border when selected, gray border when unselected
 * - Clicking the card triggers selection
 */
const CodeCard = React.forwardRef(({ id, summary, description, code, isSelected, onClick }, ref) => {
  // Determine if code is for chart generation
  const isChartCode = code && (
    code.includes('plot(') ||
    code.includes('ggplot') ||
    code.includes('hist(') ||
    code.includes('barplot') ||
    code.includes('boxplot')
  );

  const iconSrc = isChartCode ? '/chart-cc.png' : '/code-cc.png';

  return (
    <div
      ref={ref}
      onClick={() => onClick(id)}
      className={`
        p-4 mb-3 cursor-pointer transition-all bg-[#f5f8f9]
        ${isSelected ? 'border-2 border-[#add7fd]' : ''}
      `}
      style={{ borderRadius: '24px 8px 8px 8px' }}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <img
            src={iconSrc}
            alt={isChartCode ? "Chart" : "Code"}
            className="w-[36px] h-[36px]"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex-1">
            <h3 className="font-bold text-gray-800 mb-1" style={{ fontSize: '11pt' }}>
              {summary}
            </h3>
            <p className="text-gray-700" style={{ fontSize: '11pt' }}>
              {description}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
});

CodeCard.displayName = 'CodeCard';

export default CodeCard;
