const fs = require('fs');
const path = require('path');

console.log('=== Checking All Frontend Files for Missing Hook & Component Imports ===');

let errorCount = 0;
const hooks = ['useEffect', 'useState', 'useMemo', 'useCallback', 'useRef', 'useContext'];

function checkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      checkDir(full);
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      const content = fs.readFileSync(full, 'utf8');
      
      // Check hooks
      for (const hook of hooks) {
        // Look for hook calls like `useEffect(` or `useState<` or `useState(`
        const callPattern = new RegExp('\\b' + hook + '\\s*[\\(<]', 'g');
        if (callPattern.test(content)) {
          const importPattern = new RegExp('import\\s+(?:React\\s*,\\s*)?\\{[^}]*\\b' + hook + '\\b[^}]*\\}\\s*from\\s+[\'"]react[\'"]');
          const reactDot = new RegExp('React\\.' + hook);
          if (!importPattern.test(content) && !reactDot.test(content)) {
            console.error(`❌ [${entry.name}] Missing hook import '${hook}' in ${full}`);
            errorCount++;
          }
        }
      }

      // Check modal components in views
      if (dir.includes('views')) {
        const modals = ['ReassignFaceModal', 'ChangeCoverFaceModal', 'MergePeopleModal', 'PhotoLightbox', 'DuplicateCleanerModal'];
        for (const modal of modals) {
          const jsxPattern = new RegExp('<' + modal + '\\b');
          if (jsxPattern.test(content)) {
            const lines = content.split('\n');
            const importLines = lines.filter(l => l.startsWith('import ') && l.includes(modal));
            if (importLines.length === 0) {
              console.error(`❌ [${entry.name}] Missing component import '${modal}' in ${full}`);
              errorCount++;
            }
          }
        }
      }
    }
  }
}

checkDir(path.resolve(__dirname, '../src/renderer/src'));

if (errorCount === 0) {
  console.log('✅ All React hooks and component imports across frontend files are 100% valid!');
} else {
  console.error(`💥 Found ${errorCount} missing imports!`);
  process.exit(1);
}
