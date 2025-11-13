import React from 'react';

/**
 * CodeCard Component
 *
 * Displays a clickable card representing a generated R code snippet
 * - Shows a summary of the code
 * - Blue border when selected, gray border when unselected
 * - Clicking the card triggers selection
 */
const CodeCard = ({ id, summary, code, isSelected, onClick }) => {
  return (
    <div
      onClick={() => onClick(id)}
      className={`
        p-4 mb-3 rounded-lg cursor-pointer transition-all
        ${isSelected
          ? 'border-2 border-blue-500 bg-blue-50'
          : 'border-2 border-gray-300 bg-white hover:border-gray-400'
        }
      `}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <svg
              className="w-5 h-5 text-purple-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
              />
            </svg>
            <span className="font-semibold text-gray-800">R Code</span>
          </div>
          <p className="text-base text-gray-700 line-clamp-2">
            {summary}
          </p>
        </div>
        {isSelected && (
          <div className="ml-2">
            <svg
              className="w-6 h-6 text-blue-600"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
};

export default CodeCard;
