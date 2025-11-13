/**
 * API Key Test Script
 *
 * This script tests which Claude models are available with your API key
 */

import Anthropic from '@anthropic-ai/sdk';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Models to test
const modelsToTest = [
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307'
];

async function testModel(anthropic, modelName) {
  try {
    console.log(`Testing ${modelName}...`);
    const message = await anthropic.messages.create({
      model: modelName,
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: 'Hi'
      }]
    });
    console.log(`✅ ${modelName} - AVAILABLE`);
    return true;
  } catch (error) {
    if (error.status === 404) {
      console.log(`❌ ${modelName} - NOT AVAILABLE (404)`);
    } else if (error.status === 401) {
      console.log(`❌ ${modelName} - AUTHENTICATION ERROR`);
    } else {
      console.log(`❌ ${modelName} - ERROR: ${error.message}`);
    }
    return false;
  }
}

rl.question('Enter your Anthropic API key: ', async (apiKey) => {
  if (!apiKey || !apiKey.trim()) {
    console.log('No API key provided');
    rl.close();
    return;
  }

  const anthropic = new Anthropic({
    apiKey: apiKey.trim()
  });

  console.log('\n🔍 Testing Claude models...\n');

  for (const model of modelsToTest) {
    await testModel(anthropic, model);
  }

  console.log('\n✅ Test complete!\n');
  rl.close();
});
