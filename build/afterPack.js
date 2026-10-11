// Apple Silicon Macs refuse to run apps with no signature at all.
// Without a paid Apple Developer ID we give the app an "ad-hoc" signature,
// which is enough for it to open (after a one-time "Open Anyway" on download).
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
