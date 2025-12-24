import React, { useState, useRef, useEffect } from 'react';

const DatasetReport = ({ filename, reportSections }) => {
  const tabs = [
    { id: 'structure', label: 'Structure' },
    { id: 'tidyFormat', label: 'Tidy Format' },
    { id: 'missingData', label: 'Missing Data' },
    { id: 'subject', label: 'Subject' },
    { id: 'insights', label: 'Insights' }
  ];

  const [selectedTab, setSelectedTab] = useState('structure');
  const [indicatorStyle, setIndicatorStyle] = useState({});
  const tabRefs = useRef({});

  // Check if dataset is NOT in tidy format (contains warnings or suggestions for pivot_longer)
  const isNotTidy = reportSections?.tidyFormat && (
    reportSections.tidyFormat.includes('⚠️') ||
    reportSections.tidyFormat.includes('pivot_longer') ||
    reportSections.tidyFormat.toLowerCase().includes('suggest')
  );

  // Format content to make "not in tidy format" sentence bold
  const formatContent = (content, tabId) => {
    if (tabId === 'tidyFormat' && isNotTidy && content) {
      // Find and bold the sentence about dataset not being in tidy format
      const regex = /(The dataset is not in tidy format\.)/gi;
      const parts = content.split(regex);

      return parts.map((part, index) => {
        if (regex.test(part)) {
          return <strong key={index}>{part}</strong>;
        }
        return <span key={index}>{part}</span>;
      });
    }
    return content;
  };

  useEffect(() => {
    // Update indicator position when tab changes
    const currentTab = tabRefs.current[selectedTab];
    if (currentTab) {
      setIndicatorStyle({
        left: currentTab.offsetLeft,
        width: currentTab.offsetWidth
      });
    }
  }, [selectedTab]);

  return (
    <div className="dataset-report">
      <h3 className="text-base font-semibold mb-1">Dataset: {filename}</h3>

      {/* Tab Navigation */}
      <div className="relative mb-2">
        <div className="flex gap-6 border-b border-gray-300">
          {tabs.map(tab => (
            <button
              key={tab.id}
              ref={el => tabRefs.current[tab.id] = el}
              onClick={() => setSelectedTab(tab.id)}
              className={`pb-1 text-sm font-medium transition-colors ${
                selectedTab === tab.id
                  ? 'text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
              {tab.id === 'tidyFormat' && isNotTidy && (
                <span className="text-red-600">*</span>
              )}
            </button>
          ))}
        </div>

        {/* Animated underline indicator */}
        <div
          className="absolute bottom-0 h-0.5 bg-blue-600 transition-all duration-300 ease-out"
          style={indicatorStyle}
        />
      </div>

      {/* Tab Content */}
      <div className="text-sm text-gray-800 leading-relaxed mb-8">
        {formatContent(reportSections[selectedTab], selectedTab) || 'No data available for this section.'}
      </div>
    </div>
  );
};

export default DatasetReport;
