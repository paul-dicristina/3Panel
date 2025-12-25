import React from 'react';

/**
 * CodeCard Component
 *
 * Displays a clickable card representing a generated R code snippet
 * - Shows a summary of the code with an appropriate icon
 * - Uses chart-cc.png for charts, dataset-cc.png for loading data, table-cc.png for tabular output, code-cc.png otherwise
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

  // Determine if code is loading a dataset
  const isDatasetCode = !isChartCode && code && (
    code.includes('read.csv(') ||
    code.includes('read_csv(') ||
    code.includes('read.table(') ||
    code.includes('read_table(') ||
    code.includes('read.delim(') ||
    code.includes('read_delim(') ||
    code.includes('read_tsv(') ||
    code.includes('read_excel(') ||
    code.includes('read_xlsx(') ||
    code.includes('sf_query(') ||
    code.includes('readRDS(') ||
    code.includes('load(') ||
    code.includes('data(')
  );

  // Determine if code produces tabular output
  const isTableCode = !isChartCode && !isDatasetCode && code && (
    code.includes('head(') ||
    code.includes('tail(') ||
    code.includes('str(') ||
    code.includes('summary(') ||
    code.includes('glimpse(') ||
    code.includes('View(') ||
    code.includes('kable(') ||
    code.includes('gt(') ||
    code.includes('datatable(') ||
    code.includes('print(') ||
    // Common pattern: just printing a data frame variable
    /^[\w.]+\s*$/.test(code.trim())
  );

  const iconSrc = isChartCode ? '/chart-cc.png' :
                  (isDatasetCode ? '/dataset-cc.png' :
                  (isTableCode ? '/table-cc.png' : '/code-cc.png'));

  return (
    <div
      ref={ref}
      onClick={() => onClick(id)}
      className={`
        p-4 mb-3 cursor-pointer transition-all bg-[#f5f8f9]
        ${isSelected ? 'border-2 border-[#add7fd]' : ''}
      `}
      style={{
        borderRadius: '24px 8px 8px 8px',
        boxShadow: isSelected ? '0 2px 8px rgba(0, 0, 0, 0.09)' : 'none'
      }}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <img
            src={iconSrc}
            alt={isChartCode ? "Chart" : (isDatasetCode ? "Dataset" : (isTableCode ? "Table" : "Code"))}
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
