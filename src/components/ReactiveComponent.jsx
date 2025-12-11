import React, { useState, useEffect } from 'react';
import { executeRCode } from '../utils/rExecutor';

/**
 * ReactiveComponent - Shiny-inspired interactive component
 *
 * Renders controls (sliders, selects, etc.) that reactively update
 * R visualizations without requiring LLM round trips.
 */
export default function ReactiveComponent({ spec, onError }) {
  const [controlValues, setControlValues] = useState({});
  const [output, setOutput] = useState(null);
  const [isExecuting, setIsExecuting] = useState(false);

  // Initialize control values from defaults
  useEffect(() => {
    const initialValues = {};
    spec.controls.forEach(control => {
      initialValues[control.param] = control.default;
    });
    setControlValues(initialValues);
  }, [spec.controls]);

  // Execute R code whenever control values change
  useEffect(() => {
    if (Object.keys(controlValues).length === 0) return;
    executeRWithParams();
  }, [controlValues]);

  const executeRWithParams = async () => {
    setIsExecuting(true);

    // Replace template parameters in R code
    let rCode = spec.rCode;
    Object.entries(controlValues).forEach(([param, value]) => {
      // Handle different types appropriately
      const formattedValue = typeof value === 'string' ? `"${value}"` : value;
      rCode = rCode.replace(new RegExp(`{{${param}}}`, 'g'), formattedValue);
    });

    try {
      const result = await executeRCode(rCode, spec.autoFormatTabular !== false);
      setOutput(result);
      if (result.error && onError) {
        onError(result.error);
      }
    } catch (error) {
      console.error('Error executing reactive R code:', error);
      if (onError) onError(error.message);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleControlChange = (param, value) => {
    setControlValues(prev => ({
      ...prev,
      [param]: value
    }));
  };

  return (
    <div className="reactive-component bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Title */}
      {spec.title && (
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-800">{spec.title}</h3>
          {spec.description && (
            <p className="text-sm text-gray-600 mt-1">{spec.description}</p>
          )}
        </div>
      )}

      {/* Controls Panel */}
      {spec.controls && spec.controls.length > 0 && (
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {spec.controls.map((control, idx) => (
              <ControlRenderer
                key={idx}
                control={control}
                value={controlValues[control.param]}
                onChange={(value) => handleControlChange(control.param, value)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Output Panel */}
      <div className="p-4">
        {isExecuting && (
          <div className="flex items-center justify-center py-8 text-gray-500">
            <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Updating...
          </div>
        )}

        {!isExecuting && output && (
          <OutputRenderer output={output} />
        )}
      </div>
    </div>
  );
}

/**
 * Renders individual control based on type
 */
function ControlRenderer({ control, value, onChange }) {
  const { type, label, param } = control;

  const renderControl = () => {
    switch (type) {
      case 'slider':
        return (
          <SliderControl
            min={control.min}
            max={control.max}
            step={control.step || (control.max - control.min) / 100}
            value={value}
            onChange={onChange}
          />
        );

      case 'select':
        return (
          <SelectControl
            options={control.options}
            value={value}
            onChange={onChange}
          />
        );

      case 'checkbox':
        return (
          <CheckboxControl
            value={value}
            onChange={onChange}
          />
        );

      case 'text':
        return (
          <TextControl
            value={value}
            onChange={onChange}
            placeholder={control.placeholder}
          />
        );

      default:
        return <div className="text-red-500 text-sm">Unknown control type: {type}</div>;
    }
  };

  return (
    <div className="flex flex-col">
      <label className="text-sm font-medium text-gray-700 mb-1">
        {label || param}
      </label>
      {renderControl()}
    </div>
  );
}

/**
 * Slider Control Component
 */
function SliderControl({ min, max, step, value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value || min}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
      />
      <span className="text-sm font-medium text-gray-900 min-w-[3rem] text-right">
        {value !== undefined ? value.toFixed(2) : min}
      </span>
    </div>
  );
}

/**
 * Select/Dropdown Control Component
 */
function SelectControl({ options, value, onChange }) {
  return (
    <select
      value={value || options[0]}
      onChange={(e) => onChange(e.target.value)}
      className="block w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm"
    >
      {options.map((option, idx) => (
        <option key={idx} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

/**
 * Checkbox Control Component
 */
function CheckboxControl({ value, onChange }) {
  return (
    <input
      type="checkbox"
      checked={value || false}
      onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded cursor-pointer"
    />
  );
}

/**
 * Text Input Control Component
 */
function TextControl({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="block w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm"
    />
  );
}

/**
 * Renders R execution output (plots, tables, text)
 */
function OutputRenderer({ output }) {
  return (
    <div className="space-y-4">
      {/* Text Output */}
      {output.output && (
        <pre className="bg-gray-50 p-3 rounded border border-gray-200 text-sm font-mono overflow-x-auto">
          {output.output}
        </pre>
      )}

      {/* Plots */}
      {output.plots && output.plots.map((plot, idx) => (
        <div key={idx} className="plot-container">
          <img src={`data:image/png;base64,${plot}`} alt={`Plot ${idx + 1}`} />
        </div>
      ))}

      {/* Tables */}
      {output.tables && output.tables.map((table, idx) => (
        <div key={idx} dangerouslySetInnerHTML={{ __html: table }} />
      ))}

      {/* Error */}
      {output.error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-red-800 text-sm">
          <strong>Error:</strong> {output.error}
        </div>
      )}
    </div>
  );
}
