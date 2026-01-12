import React from 'react';

/**
 * DatasetRestorationBanner Component
 *
 * Warning banner shown when conversation is restored with datasets
 * Informs user that datasets need to be manually reloaded
 */
const DatasetRestorationBanner = ({ isVisible, datasetRegistry, onDismiss }) => {
  if (!isVisible || !datasetRegistry?.datasets) return null;

  const datasetNames = Object.keys(datasetRegistry.datasets);
  if (datasetNames.length === 0) return null;

  // Separate base datasets from tidy transformations
  const baseDatasets = datasetNames.filter(name => !name.endsWith('_tidy'));
  const tidyDatasets = datasetNames.filter(name => name.endsWith('_tidy'));

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-3">
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <svg className="h-5 w-5 text-amber-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div className="ml-3 flex-1">
          <h3 className="text-sm font-semibold text-amber-900">
            Previous session restored
          </h3>
          <div className="mt-1 text-sm text-amber-800">
            <p className="mb-2">These datasets need to be reloaded:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              {baseDatasets.map(name => {
                const dataset = datasetRegistry.datasets[name];
                const source = dataset?.source || 'unknown';
                const filename = dataset?.filename || name;
                return (
                  <li key={name}>
                    <span className="font-medium">{filename}</span>
                    {source === 'csv' && ' (upload CSV file)'}
                    {source === 'snowflake' && ' (reconnect to Snowflake)'}
                  </li>
                );
              })}
              {tidyDatasets.map(name => {
                const baseName = name.replace('_tidy', '');
                return (
                  <li key={name} className="text-amber-700">
                    <span className="font-medium">{name}</span> (transformation - reload <span className="font-medium">{baseName}</span> first)
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div className="ml-3 flex-shrink-0">
          <button
            onClick={onDismiss}
            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-amber-900 bg-amber-100 hover:bg-amber-200 rounded-md transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};

export default DatasetRestorationBanner;
