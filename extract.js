const acorn = require('acorn');
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, 'obfuscated.js'), 'utf-8');
const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });

// Generic recursive AST walker
function walk(node, callback) {
  if (!node || typeof node !== 'object' || !node.type) return;
  callback(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && item.type) walk(item, callback);
      }
    } else if (child && typeof child === 'object' && child.type) {
      walk(child, callback);
    }
  }
}

// Step 1: Find "&vrf=" in string concatenation → get the vrf variable name
function findVrfVarName() {
  let result = null;
  walk(ast, (node) => {
    if (result) return;
    if (node.type !== 'BinaryExpression' || node.operator !== '+') return;

    // Pattern: (... + "&vrf=") + vrfVar
    // Left child is a BinaryExpression whose right is Literal containing "&vrf="
    if (node.left?.type === 'BinaryExpression' &&
        node.left.right?.type === 'Literal' &&
        typeof node.left.right.value === 'string' &&
        node.left.right.value.includes('&vrf=')) {
      if (node.right?.type === 'Identifier') {
        result = node.right.name;
      }
    }

    // Pattern: "&vrf=" + vrfVar (direct, no left nesting)
    if (node.left?.type === 'Literal' &&
        typeof node.left.value === 'string' &&
        node.left.value.includes('&vrf=')) {
      if (node.right?.type === 'Identifier') {
        result = node.right.name;
      }
    }
  });
  return result;
}

// Step 2-3: Find assignment to vrfVar (skip `var x = null` declarations)
function findVrfAssignment(vrfVarName) {
  let result = null;
  walk(ast, (node) => {
    if (result) return;
    if (node.type === 'AssignmentExpression' &&
        node.left?.type === 'Identifier' &&
        node.left.name === vrfVarName) {
      result = node.right;
    }
  });
  return result;
}

// Step 4: From the assignment RHS, dig into the 2nd argument
//   and find the CallExpression (that's our target function)
//   Pattern: await outerFunc(movieId, targetFunc() + "_" + userId)
function findTargetFuncName(assignmentRight) {
  let callExpr = assignmentRight;

  // Unwrap AwaitExpression
  if (callExpr?.type === 'AwaitExpression') {
    callExpr = callExpr.argument;
  }
  if (callExpr?.type !== 'CallExpression') return null;

  // Get 2nd argument (index 1)
  const secondArg = callExpr.arguments?.[1];
  if (!secondArg) return null;

  // Find the first CallExpression inside the 2nd argument
  let result = null;
  walk(secondArg, (node) => {
    if (result) return;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
      result = node.callee.name;
    }
  });
  return result;
}

// Step 5: Find the function declaration/expression and extract its return value
function findFunctionReturnValue(funcName) {
  let result = null;

  walk(ast, (node) => {
    if (result !== null) return;

    let body = null;

    // FunctionDeclaration: function funcName() { return "..."; }
    if (node.type === 'FunctionDeclaration' && node.id?.name === funcName) {
      body = node.body;
    }

    // VariableDeclarator: const funcName = function() { ... } or () => { ... }
    if (node.type === 'VariableDeclarator' && node.id?.name === funcName &&
        (node.init?.type === 'FunctionExpression' || node.init?.type === 'ArrowFunctionExpression')) {
      body = node.init.body;
    }

    if (!body) return;

    walk(body, (inner) => {
      if (result !== null) return;
      if (inner.type === 'ReturnStatement' && inner.argument?.type === 'Literal') {
        result = inner.argument.value;
      }
    });
  });

  return result;
}

// --- Execute ---
const vrfVarName = findVrfVarName();
console.log('Step 1 - VRF variable name:', vrfVarName);

const assignmentRight = findVrfAssignment(vrfVarName);
console.log('Step 2-3 - Found assignment:', !!assignmentRight);

const targetFuncName = findTargetFuncName(assignmentRight);
console.log('Step 4 - Target function name:', targetFuncName);

const result = findFunctionReturnValue(targetFuncName);
console.log('Step 5 - Result:', result);

// Write result to abc.txt
const outputPath = path.join(__dirname, 'abc.txt');
fs.writeFileSync(outputPath, String(result), 'utf-8');
console.log(`Result written to: ${outputPath}`);
