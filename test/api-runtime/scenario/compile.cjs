'use strict';
// Invoked only by the separately reviewed public-preparation step. Never require app code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const requireThat = (ok, code) => { if (!ok) throw new Error(code); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const once = (text, before, after) => {
  requireThat(text.split(before).length === 2, 'MUTANT_SOURCE_SHAPE');
  return text.replace(before, after);
};

// These programs run only during a separately approved install/emit invocation.
// No application module is evaluated; source and public declarations are data.
const INDEX_HELPER_SOURCE = 'src1/modules/common/utils/indexReadiness.ts';
const INDEX_HELPER_SHA = '050ecc993c862638cf4912bb854e04baa5d80241cb124e7831fc3c95a78db5bd';
const INDEX_TDZ_SHA = '6597c1a03c54702d89042a29263da81399934e68e8fb6c46f91c638cbe954400';
const INDEX_COMPILER_SHA = '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675';
const INDEX_TYPE_LIBRARY_HASHES = Object.freeze({
  "lib.decorators.d.ts": "8e7f8264d0fb4c5339605a15daadb037bf238c10b654bb3eee14208f860a32ea",
  "lib.decorators.legacy.d.ts": "782dec38049b92d4e85c1585fbea5474a219c6984a35b004963b00beb1aab538",
  "lib.es2015.collection.d.ts": "dc2df20b1bcdc8c2d34af4926e2c3ab15ffe1160a63e58b7e09833f616efff44",
  "lib.es2015.core.d.ts": "c57796738e7f83dbc4b8e65132f11a377649c00dd3eee333f672b8f0a6bea671",
  "lib.es2015.d.ts": "45b7ab580deca34ae9729e97c13cfd999df04416a79116c3bfb483804f85ded4",
  "lib.es2015.generator.d.ts": "515d0b7b9bea2e31ea4ec968e9edd2c39d3eebf4a2d5cbd04e88639819ae3b71",
  "lib.es2015.iterable.d.ts": "0559b1f683ac7505ae451f9a96ce4c3c92bdc71411651ca6ddb0e88baaaad6a3",
  "lib.es2015.promise.d.ts": "0dc1e7ceda9b8b9b455c3a2d67b0412feab00bd2f66656cd8850e8831b08b537",
  "lib.es2015.proxy.d.ts": "ce691fb9e5c64efb9547083e4a34091bcbe5bdb41027e310ebba8f7d96a98671",
  "lib.es2015.reflect.d.ts": "8d697a2a929a5fcb38b7a65594020fcef05ec1630804a33748829c5ff53640d0",
  "lib.es2015.symbol.d.ts": "4ff2a353abf8a80ee399af572debb8faab2d33ad38c4b4474cff7f26e7653b8d",
  "lib.es2015.symbol.wellknown.d.ts": "fb0f136d372979348d59b3f5020b4cdb81b5504192b1cacff5d1fbba29378aa1",
  "lib.es2016.array.include.d.ts": "d15bea3d62cbbdb9797079416b8ac375ae99162a7fba5de2c6c505446486ac0a",
  "lib.es2016.d.ts": "3facaf05f0c5fc569c5649dd359892c98a85557e3e0c847964caeb67076f4d75",
  "lib.es2016.intl.d.ts": "68d18b664c9d32a7336a70235958b8997ebc1c3b8505f4f1ae2b7e7753b87618",
  "lib.es2017.arraybuffer.d.ts": "eb3d66c8327153d8fa7dd03f9c58d351107fe824c79e9b56b462935176cdf12a",
  "lib.es2017.d.ts": "e44bb8bbac7f10ecc786703fe0a6a4b952189f908707980ba8f3c8975a760962",
  "lib.es2017.date.d.ts": "38f0219c9e23c915ef9790ab1d680440d95419ad264816fa15009a8851e79119",
  "lib.es2017.intl.d.ts": "4de680d5bb41c17f7f68e0419412ca23c98d5749dcaaea1896172f06435891fc",
  "lib.es2017.object.d.ts": "69ab18c3b76cd9b1be3d188eaf8bba06112ebbe2f47f6c322b5105a6fbc45a2e",
  "lib.es2017.sharedmemory.d.ts": "a680117f487a4d2f30ea46f1b4b7f58bef1480456e18ba53ee85c2746eeca012",
  "lib.es2017.string.d.ts": "2f11ff796926e0832f9ae148008138ad583bd181899ab7dd768a2666700b1893",
  "lib.es2017.typedarrays.d.ts": "954296b30da6d508a104a3a0b5d96b76495c709785c1d11610908e63481ee667",
  "lib.es2018.asyncgenerator.d.ts": "ac9538681b19688c8eae65811b329d3744af679e0bdfa5d842d0e32524c73e1c",
  "lib.es2018.asynciterable.d.ts": "0a969edff4bd52585473d24995c5ef223f6652d6ef46193309b3921d65dd4376",
  "lib.es2018.d.ts": "5e1c4c362065a6b95ff952c0eab010f04dcd2c3494e813b493ecfd4fcb9fc0d8",
  "lib.es2018.intl.d.ts": "9e9fbd7030c440b33d021da145d3232984c8bb7916f277e8ffd3dc2e3eae2bdb",
  "lib.es2018.promise.d.ts": "811ec78f7fefcabbda4bfa93b3eb67d9ae166ef95f9bff989d964061cbf81a0c",
  "lib.es2018.regexp.d.ts": "717937616a17072082152a2ef351cb51f98802fb4b2fdabd32399843875974ca",
  "lib.es2019.array.d.ts": "d7e7d9b7b50e5f22c915b525acc5a49a7a6584cf8f62d0569e557c5cfc4b2ac2",
  "lib.es2019.d.ts": "68d73b4a11549f9c0b7d352d10e91e5dca8faa3322bfb77b661839c42b1ddec7",
  "lib.es2019.intl.d.ts": "74f7fa2d027d5b33eb0471c8e82a6c87216223181ec31247c357a3e8e2fddc5b",
  "lib.es2019.object.d.ts": "71c37f4c9543f31dfced6c7840e068c5a5aacb7b89111a4364b1d5276b852557",
  "lib.es2019.string.d.ts": "576711e016cf4f1804676043e6a0a5414252560eb57de9faceee34d79798c850",
  "lib.es2019.symbol.d.ts": "89c1b1281ba7b8a96efc676b11b264de7a8374c5ea1e6617f11880a13fc56dc6",
  "lib.es2020.bigint.d.ts": "d6d7ae4d1f1f3772e2a3cde568ed08991a8ae34a080ff1151af28b7f798e22ca",
  "lib.es2020.d.ts": "5efce4fc3c29ea84e8928f97adec086e3dc876365e0982cc8479a07954a3efd4",
  "lib.es2020.date.d.ts": "063600664504610fe3e99b717a1223f8b1900087fab0b4cad1496a114744f8df",
  "lib.es2020.intl.d.ts": "639e512c0dfc3fad96a84caad71b8834d66329a1f28dc95e3946c9b58176c73a",
  "lib.es2020.number.d.ts": "368af93f74c9c932edd84c58883e736c9e3d53cec1fe24c0b0ff451f529ceab1",
  "lib.es2020.promise.d.ts": "934019d7e3c81950f9a8426d093458b65d5aff2c7c1511233c0fd5b941e608ab",
  "lib.es2020.sharedmemory.d.ts": "52ada8e0b6e0482b728070b7639ee42e83a9b1c22d205992756fe020fd9f4a47",
  "lib.es2020.string.d.ts": "3bdefe1bfd4d6dee0e26f928f93ccc128f1b64d5d501ff4a8cf3c6371200e5e6",
  "lib.es2020.symbol.wellknown.d.ts": "59fb2c069260b4ba00b5643b907ef5d5341b167e7d1dbf58dfd895658bda2867",
  "lib.es5.d.ts": "c430d44666289dae81f30fa7b2edebf186ecc91a2d4c71266ea6ae76388792e1"
});
const INDEX_TYPE_OPTIONS = Object.freeze({ target: 'ES2020', module: 'CommonJS', moduleResolution: 'Node10',
  noEmit: true, lib: ['lib.es2020.d.ts'], types: [], typeRoots: [], strict: true,
  noImplicitAny: true, noImplicitThis: true, noImplicitReturns: true,
  noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true, skipLibCheck: false });

function selectedHelperTypecheck(sourceRoot, runtimeRoot, nominalText) {
  requireThat(ts.version === '5.9.3' && sha(Buffer.from(nominalText)) === INDEX_HELPER_SHA, 'INDEX_TYPECHECK_INPUT');
  const libraryRoot = path.join(runtimeRoot, 'node_modules/typescript/lib');
  const readRegular = filename => {
    const st = fs.lstatSync(filename);
    requireThat(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && fs.realpathSync(filename) === filename, 'INDEX_TYPECHECK_REGULAR_INPUT');
    return fs.readFileSync(filename);
  };
  requireThat(sha(readRegular(path.join(libraryRoot, 'typescript.js'))) === INDEX_COMPILER_SHA, 'INDEX_TYPECHECK_COMPILER');
  const texts = new Map(); const sourceIds = new Map(); const libraryFiles = {};
  for (const [name, expected] of Object.entries(INDEX_TYPE_LIBRARY_HASHES)) {
    requireThat(/^lib\.[a-z0-9.]+\.d\.ts$/.test(name), 'INDEX_TYPECHECK_LIBRARY_NAME');
    const filename = path.join(libraryRoot, name); const bytes = readRegular(filename);
    requireThat(sha(bytes) === expected, 'INDEX_TYPECHECK_LIBRARY_HASH');
    texts.set(filename, bytes.toString('utf8')); sourceIds.set(filename, 'node_modules/typescript/lib/' + name);
    libraryFiles[name] = expected;
  }
  requireThat(texts.size === 45, 'INDEX_TYPECHECK_LIBRARY_COUNT');
  let rejected = once(nominalText,
    '            for (let indexOrdinal = 0; indexOrdinal <= requirementsForCollection.indexes.length; indexOrdinal += 1) {',
    '            const requirements = requirementsForCollection;\n            for (let indexOrdinal = 0; indexOrdinal <= requirements.indexes.length; indexOrdinal += 1) {');
  rejected = once(rejected, '                } : requirementsForCollection.indexes[indexOrdinal - 1];',
    '                } : requirements.indexes[indexOrdinal - 1];');
  requireThat(sha(Buffer.from(rejected)) === INDEX_TDZ_SHA, 'INDEX_TYPECHECK_TDZ_HASH');
  const reference = 'const requirementsForCollection = requirements[collectionOrdinal]';
  requireThat(rejected.split(reference).length === 2, 'INDEX_TYPECHECK_TDZ_REFERENCE');
  const referenceOffset = rejected.indexOf(reference) + 'const requirementsForCollection = '.length;
  const libraryIds = [...sourceIds.values()].sort();
  const report = { schema: 'SD-SELECTED-INDEX-TYPECHECK-1', status: 'FAIL', compiler: ts.version,
    compilerSha256: INDEX_COMPILER_SHA, source: INDEX_HELPER_SOURCE, sourceSha256: INDEX_HELPER_SHA,
    libraryFiles, options: INDEX_TYPE_OPTIONS, programFiles: [], diagnostics: [],
    tdzControl: { status: 'FAILED', sourceSha256: INDEX_TDZ_SHA, requiredCode: 2448,
      referenceOffset, programFiles: [], diagnostics: [] } };
  let programFailure = false;
  for (const isNegative of [false, true]) {
    const filename = isNegative ? path.join(runtimeRoot, '__selected_index_tdz__.ts') : path.join(sourceRoot, INDEX_HELPER_SOURCE);
    const sourceId = isNegative ? 'VIRTUAL_SELECTED_INDEX_TDZ.ts' : INDEX_HELPER_SOURCE;
    const allowedTexts = new Map(texts); allowedTexts.set(filename, isNegative ? rejected : nominalText);
    const ids = new Map(sourceIds); ids.set(filename, sourceId);
    const directories = new Set([...allowedTexts.keys()].map(file => path.dirname(file)));
    const compilerOptions = { ...INDEX_TYPE_OPTIONS, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10, lib: ['lib.es2020.d.ts'], types: [], typeRoots: [] };
    const host = {
      fileExists: file => allowedTexts.has(path.resolve(file)),
      readFile: file => allowedTexts.get(path.resolve(file)),
      getSourceFile(file, languageVersion, onError) {
        const data = host.readFile(file);
        if (data === undefined) { if (onError) onError('INDEX_DECLARATION_UNAVAILABLE'); return undefined; }
        return ts.createSourceFile(file, data, languageVersion, true);
      },
      directoryExists: directory => directories.has(path.resolve(directory)), getDirectories: () => [],
      getCurrentDirectory: () => runtimeRoot, getCanonicalFileName: file => file,
      useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
      getDefaultLibFileName: () => path.join(libraryRoot, 'lib.es2020.d.ts'),
      resolveModuleNames: names => names.map(() => undefined),
      writeFile: () => { throw new Error('INDEX_TYPECHECK_EMIT_FORBIDDEN'); },
    };
    try {
      const program = ts.createProgram([filename], compilerOptions, host);
      const foundFiles = program.getSourceFiles().map(file => ids.get(path.resolve(file.fileName)) || 'UNDECLARED_SOURCE').sort();
      const actual = ts.getPreEmitDiagnostics(program).map(item => ({
        sourceId: item.file ? ids.get(path.resolve(item.file.fileName)) || 'UNDECLARED_SOURCE' : null,
        code: item.code, category: item.category, start: item.start === undefined ? null : item.start,
        length: item.length === undefined ? null : item.length,
      }));
      const exactSet = JSON.stringify(foundFiles) === JSON.stringify([...libraryIds, sourceId].sort());
      if (isNegative) {
        report.tdzControl.programFiles = foundFiles; report.tdzControl.diagnostics = actual;
        if (exactSet && actual.some(item => item.category === ts.DiagnosticCategory.Error && item.code === 2448
          && item.sourceId === sourceId && item.start === referenceOffset && item.length === 'requirements'.length)) report.tdzControl.status = 'REJECTED';
      } else {
        report.programFiles = foundFiles; report.diagnostics = actual;
        if (!exactSet) programFailure = true;
      }
    } catch { programFailure = true; }
  }
  if (!programFailure && report.diagnostics.length === 0 && report.tdzControl.status === 'REJECTED') report.status = 'PASS';
  if (report.status !== 'PASS') {
    // Existing private preparation stdout retains only public diagnostic metadata.
    // No Error/message/path/context or source value is printed.
    process.stdout.write(JSON.stringify({ schema: 'SD-SELECTED-INDEX-TYPECHECK-FAILURE-1', report }) + '\n');
    throw new Error('INDEX_SELECTED_HELPER_TYPECHECK_FAILED');
  }
  return report;
}

// Frozen broad standard-library admission. Executed only by approved preparation.
const BROAD_LIBRARY_HASHES = Object.freeze({
  "lib.d.ts": "a7297ff837fcdf174a9524925966429eb8e5feecc2cc55cc06574e6b092c1eaa",
  "lib.decorators.d.ts": "8e7f8264d0fb4c5339605a15daadb037bf238c10b654bb3eee14208f860a32ea",
  "lib.decorators.legacy.d.ts": "782dec38049b92d4e85c1585fbea5474a219c6984a35b004963b00beb1aab538",
  "lib.dom.asynciterable.d.ts": "d7a3c8b952931daebdfc7a2897c53c0a1c73624593fa070e46bd537e64dcd20a",
  "lib.dom.d.ts": "080941d9f9ff9307f7e27a83bcd888b7c8270716c39af943532438932ec1d0b9",
  "lib.dom.iterable.d.ts": "2e80ee7a49e8ac312cc11b77f1475804bee36b3b2bc896bead8b6e1266befb43",
  "lib.es2015.collection.d.ts": "dc2df20b1bcdc8c2d34af4926e2c3ab15ffe1160a63e58b7e09833f616efff44",
  "lib.es2015.core.d.ts": "c57796738e7f83dbc4b8e65132f11a377649c00dd3eee333f672b8f0a6bea671",
  "lib.es2015.d.ts": "45b7ab580deca34ae9729e97c13cfd999df04416a79116c3bfb483804f85ded4",
  "lib.es2015.generator.d.ts": "515d0b7b9bea2e31ea4ec968e9edd2c39d3eebf4a2d5cbd04e88639819ae3b71",
  "lib.es2015.iterable.d.ts": "0559b1f683ac7505ae451f9a96ce4c3c92bdc71411651ca6ddb0e88baaaad6a3",
  "lib.es2015.promise.d.ts": "0dc1e7ceda9b8b9b455c3a2d67b0412feab00bd2f66656cd8850e8831b08b537",
  "lib.es2015.proxy.d.ts": "ce691fb9e5c64efb9547083e4a34091bcbe5bdb41027e310ebba8f7d96a98671",
  "lib.es2015.reflect.d.ts": "8d697a2a929a5fcb38b7a65594020fcef05ec1630804a33748829c5ff53640d0",
  "lib.es2015.symbol.d.ts": "4ff2a353abf8a80ee399af572debb8faab2d33ad38c4b4474cff7f26e7653b8d",
  "lib.es2015.symbol.wellknown.d.ts": "fb0f136d372979348d59b3f5020b4cdb81b5504192b1cacff5d1fbba29378aa1",
  "lib.es2016.array.include.d.ts": "d15bea3d62cbbdb9797079416b8ac375ae99162a7fba5de2c6c505446486ac0a",
  "lib.es2016.d.ts": "3facaf05f0c5fc569c5649dd359892c98a85557e3e0c847964caeb67076f4d75",
  "lib.es2016.full.d.ts": "807e0e0bdc67605dd28efe18f20ab5fcd75d944ef95936120702335f9379094b",
  "lib.es2016.intl.d.ts": "68d18b664c9d32a7336a70235958b8997ebc1c3b8505f4f1ae2b7e7753b87618",
  "lib.es2017.arraybuffer.d.ts": "eb3d66c8327153d8fa7dd03f9c58d351107fe824c79e9b56b462935176cdf12a",
  "lib.es2017.d.ts": "e44bb8bbac7f10ecc786703fe0a6a4b952189f908707980ba8f3c8975a760962",
  "lib.es2017.date.d.ts": "38f0219c9e23c915ef9790ab1d680440d95419ad264816fa15009a8851e79119",
  "lib.es2017.full.d.ts": "1d242d5c24cf285c88bc4fb93c5ff903de8319064e282986edeb6247ba028d5e",
  "lib.es2017.intl.d.ts": "4de680d5bb41c17f7f68e0419412ca23c98d5749dcaaea1896172f06435891fc",
  "lib.es2017.object.d.ts": "69ab18c3b76cd9b1be3d188eaf8bba06112ebbe2f47f6c322b5105a6fbc45a2e",
  "lib.es2017.sharedmemory.d.ts": "a680117f487a4d2f30ea46f1b4b7f58bef1480456e18ba53ee85c2746eeca012",
  "lib.es2017.string.d.ts": "2f11ff796926e0832f9ae148008138ad583bd181899ab7dd768a2666700b1893",
  "lib.es2017.typedarrays.d.ts": "954296b30da6d508a104a3a0b5d96b76495c709785c1d11610908e63481ee667",
  "lib.es2018.asyncgenerator.d.ts": "ac9538681b19688c8eae65811b329d3744af679e0bdfa5d842d0e32524c73e1c",
  "lib.es2018.asynciterable.d.ts": "0a969edff4bd52585473d24995c5ef223f6652d6ef46193309b3921d65dd4376",
  "lib.es2018.d.ts": "5e1c4c362065a6b95ff952c0eab010f04dcd2c3494e813b493ecfd4fcb9fc0d8",
  "lib.es2018.full.d.ts": "95f1023b824c2c511c48f1201e2d1188bcb0ca1138a309a870b956d2e92e44ab",
  "lib.es2018.intl.d.ts": "9e9fbd7030c440b33d021da145d3232984c8bb7916f277e8ffd3dc2e3eae2bdb",
  "lib.es2018.promise.d.ts": "811ec78f7fefcabbda4bfa93b3eb67d9ae166ef95f9bff989d964061cbf81a0c",
  "lib.es2018.regexp.d.ts": "717937616a17072082152a2ef351cb51f98802fb4b2fdabd32399843875974ca",
  "lib.es2019.array.d.ts": "d7e7d9b7b50e5f22c915b525acc5a49a7a6584cf8f62d0569e557c5cfc4b2ac2",
  "lib.es2019.d.ts": "68d73b4a11549f9c0b7d352d10e91e5dca8faa3322bfb77b661839c42b1ddec7",
  "lib.es2019.full.d.ts": "08f6861df84fba9719c14d5adc3ba40be9f0c687639e6c4df3c05b9301b8ff94",
  "lib.es2019.intl.d.ts": "74f7fa2d027d5b33eb0471c8e82a6c87216223181ec31247c357a3e8e2fddc5b",
  "lib.es2019.object.d.ts": "71c37f4c9543f31dfced6c7840e068c5a5aacb7b89111a4364b1d5276b852557",
  "lib.es2019.string.d.ts": "576711e016cf4f1804676043e6a0a5414252560eb57de9faceee34d79798c850",
  "lib.es2019.symbol.d.ts": "89c1b1281ba7b8a96efc676b11b264de7a8374c5ea1e6617f11880a13fc56dc6",
  "lib.es2020.bigint.d.ts": "d6d7ae4d1f1f3772e2a3cde568ed08991a8ae34a080ff1151af28b7f798e22ca",
  "lib.es2020.d.ts": "5efce4fc3c29ea84e8928f97adec086e3dc876365e0982cc8479a07954a3efd4",
  "lib.es2020.date.d.ts": "063600664504610fe3e99b717a1223f8b1900087fab0b4cad1496a114744f8df",
  "lib.es2020.full.d.ts": "1305d1e76ca44e30fb8b2b8075fa522b83f60c0bcf5d4326a9d2cf79b53724f8",
  "lib.es2020.intl.d.ts": "639e512c0dfc3fad96a84caad71b8834d66329a1f28dc95e3946c9b58176c73a",
  "lib.es2020.number.d.ts": "368af93f74c9c932edd84c58883e736c9e3d53cec1fe24c0b0ff451f529ceab1",
  "lib.es2020.promise.d.ts": "934019d7e3c81950f9a8426d093458b65d5aff2c7c1511233c0fd5b941e608ab",
  "lib.es2020.sharedmemory.d.ts": "52ada8e0b6e0482b728070b7639ee42e83a9b1c22d205992756fe020fd9f4a47",
  "lib.es2020.string.d.ts": "3bdefe1bfd4d6dee0e26f928f93ccc128f1b64d5d501ff4a8cf3c6371200e5e6",
  "lib.es2020.symbol.wellknown.d.ts": "59fb2c069260b4ba00b5643b907ef5d5341b167e7d1dbf58dfd895658bda2867",
  "lib.es2021.d.ts": "feecb1be483ed332fad555aff858affd90a48ab19ba7272ee084704eb7167569",
  "lib.es2021.full.d.ts": "4a66df3ab5de5cfcda11538cffddd67ff6a174e003788e270914c1e0248483cf",
  "lib.es2021.intl.d.ts": "965f36eae237dd74e6cca203a43e9ca801ce38824ead814728a2807b1910117d",
  "lib.es2021.promise.d.ts": "af3dd424cf267428f30ccfc376f47a2c0114546b55c44d8c0f1d57d841e28d74",
  "lib.es2021.string.d.ts": "995c005ab91a498455ea8dfb63aa9f83fa2ea793c3d8aa344be4a1678d06d399",
  "lib.es2021.weakref.d.ts": "959d36cddf5e7d572a65045b876f2956c973a586da58e5d26cde519184fd9b8a",
  "lib.es2022.array.d.ts": "3925a6c820dcb1a06506c90b1577db1fdbf7705d65b62b99dce4be75c637e26b",
  "lib.es2022.d.ts": "ee7bad0c15b58988daa84371e0b89d313b762ab83cb5b31b8a2d1162e8eb41c2",
  "lib.es2022.error.d.ts": "0a3d63ef2b853447ec4f749d3f368ce642264246e02911fcb1590d8c161b8005",
  "lib.es2022.full.d.ts": "3cbad9a1ba4453443026ed38e4b8be018abb26565fa7c944376463ad9df07c41",
  "lib.es2022.intl.d.ts": "8cdf8847677ac7d20486e54dd3fcf09eda95812ac8ace44b4418da1bbbab6eb8",
  "lib.es2022.object.d.ts": "8444af78980e3b20b49324f4a16ba35024fef3ee069a0eb67616ea6ca821c47a",
  "lib.es2022.regexp.d.ts": "b4b67b1a91182421f5df999988c690f14d813b9850b40acd06ed44691f6727ad",
  "lib.es2022.string.d.ts": "3287d9d085fbd618c3971944b65b4be57859f5415f495b33a6adc994edd2f004",
  "lib.es2023.array.d.ts": "df83c2a6c73228b625b0beb6669c7ee2a09c914637e2d35170723ad49c0f5cd4",
  "lib.es2023.collection.d.ts": "436aaf437562f276ec2ddbee2f2cdedac7664c1e4c1d2c36839ddd582eeb3d0a",
  "lib.es2023.d.ts": "27bdc30a0e32783366a5abeda841bc22757c1797de8681bbe81fbc735eeb1c10",
  "lib.es2023.full.d.ts": "785921608325fa246b450f05b238f4b3ed659f1099af278ce9ebbc9416a13f1d",
  "lib.es2023.intl.d.ts": "8e3c06ea092138bf9fa5e874a1fdbc9d54805d074bee1de31b99a11e2fec239d",
  "lib.es2024.arraybuffer.d.ts": "87dc0f382502f5bbce5129bdc0aea21e19a3abbc19259e0b43ae038a9fc4e326",
  "lib.es2024.collection.d.ts": "b1cb28af0c891c8c96b2d6b7be76bd394fddcfdb4709a20ba05a7c1605eea0f9",
  "lib.es2024.d.ts": "8fd575e12870e9944c7e1d62e1f5a73fcf23dd8d3a321f2a2c74c20d022283fe",
  "lib.es2024.full.d.ts": "b3e9cef4eed59f8a2249ed834ba4aabe9d0d4e9037d4679487fa17dad99004a3",
  "lib.es2024.object.d.ts": "2fef54945a13095fdb9b84f705f2b5994597640c46afeb2ce78352fab4cb3279",
  "lib.es2024.promise.d.ts": "ac77cb3e8c6d3565793eb90a8373ee8033146315a3dbead3bde8db5eaf5e5ec6",
  "lib.es2024.regexp.d.ts": "56e4ed5aab5f5920980066a9409bfaf53e6d21d3f8d020c17e4de584d29600ad",
  "lib.es2024.sharedmemory.d.ts": "4ece9f17b3866cc077099c73f4983bddbcb1dc7ddb943227f1ec070f529dedd1",
  "lib.es2024.string.d.ts": "0a6282c8827e4b9a95f4bf4f5c205673ada31b982f50572d27103df8ceb8013c",
  "lib.es5.d.ts": "c430d44666289dae81f30fa7b2edebf186ecc91a2d4c71266ea6ae76388792e1",
  "lib.es6.d.ts": "df039a67536fe2acc3affdcbfb645892f842db36fe599e8e652e2f0c640a90d1",
  "lib.esnext.array.d.ts": "1c9319a09485199c1f7b0498f2988d6d2249793ef67edda49d1e584746be9032",
  "lib.esnext.collection.d.ts": "e3a2a0cee0f03ffdde24d89660eba2685bfbdeae955a6c67e8c4c9fd28928eeb",
  "lib.esnext.d.ts": "2ab096661c711e4a81cc464fa1e6feb929a54f5340b46b0a07ac6bbf857471f0",
  "lib.esnext.decorators.d.ts": "d4b1d2c51d058fc21ec2629fff7a76249dec2e36e12960ea056e3ef89174080f",
  "lib.esnext.disposable.d.ts": "51ad4c928303041605b4d7ae32e0c1ee387d43a24cd6f1ebf4a2699e1076d4fa",
  "lib.esnext.error.d.ts": "73f78680d4c08509933daf80947902f6ff41b6230f94dd002ae372620adb0f60",
  "lib.esnext.float16.d.ts": "196cb558a13d4533a5163286f30b0509ce0210e4b316c56c38d4c0fd2fb38405",
  "lib.esnext.full.d.ts": "bde31fd423cd93b0eff97197a3f66df7c93e8c0c335cbeb113b7ff1ac35c23f4",
  "lib.esnext.intl.d.ts": "811c71eee4aa0ac5f7adf713323a5c41b0cf6c4e17367a34fbce379e12bbf0a4",
  "lib.esnext.iterator.d.ts": "22adec94ef7047a6c9d1af3cb96be87a335908bf9ef386ae9fd50eeb37f44c47",
  "lib.esnext.promise.d.ts": "60037901da1a425516449b9a20073aa03386cce92f7a1fd902d7602be3a7c2e9",
  "lib.esnext.sharedmemory.d.ts": "c5239f5c01bcfa9cd32f37c496cf19c61d69d37e48be9de612b541aac915805b",
  "lib.scripthost.d.ts": "cd034f499c6cdca722b60c04b5b1b78e058487a7085a8e0d6fb50809947ee573",
  "lib.webworker.asynciterable.d.ts": "ca417afee74054e99d5a8252b35bef26ca6e2942d67d343fce6b42fc9f432993",
  "lib.webworker.d.ts": "6d08cde2bfb6ff909efbf7cb7d6d55be412cf4b9f48fd0430185986973fa91f5",
  "lib.webworker.importscripts.d.ts": "80e18897e5884b6723488d4f5652167e7bb5024f946743134ecc4aa4ee731f89",
  "lib.webworker.iterable.d.ts": "d6c6331ce67c41b2ad5bfb0c8c022403980b479a377a44da8f16b61120418f66"
});
const BROAD_DEFAULT_LIBRARY_NAMES = Object.freeze(["lib.decorators.d.ts","lib.decorators.legacy.d.ts","lib.dom.asynciterable.d.ts","lib.dom.d.ts","lib.dom.iterable.d.ts","lib.es2015.collection.d.ts","lib.es2015.core.d.ts","lib.es2015.d.ts","lib.es2015.generator.d.ts","lib.es2015.iterable.d.ts","lib.es2015.promise.d.ts","lib.es2015.proxy.d.ts","lib.es2015.reflect.d.ts","lib.es2015.symbol.d.ts","lib.es2015.symbol.wellknown.d.ts","lib.es2016.array.include.d.ts","lib.es2016.d.ts","lib.es2016.intl.d.ts","lib.es2017.arraybuffer.d.ts","lib.es2017.d.ts","lib.es2017.date.d.ts","lib.es2017.intl.d.ts","lib.es2017.object.d.ts","lib.es2017.sharedmemory.d.ts","lib.es2017.string.d.ts","lib.es2017.typedarrays.d.ts","lib.es2018.asyncgenerator.d.ts","lib.es2018.asynciterable.d.ts","lib.es2018.d.ts","lib.es2018.intl.d.ts","lib.es2018.promise.d.ts","lib.es2018.regexp.d.ts","lib.es2019.array.d.ts","lib.es2019.d.ts","lib.es2019.intl.d.ts","lib.es2019.object.d.ts","lib.es2019.string.d.ts","lib.es2019.symbol.d.ts","lib.es2020.bigint.d.ts","lib.es2020.d.ts","lib.es2020.date.d.ts","lib.es2020.full.d.ts","lib.es2020.intl.d.ts","lib.es2020.number.d.ts","lib.es2020.promise.d.ts","lib.es2020.sharedmemory.d.ts","lib.es2020.string.d.ts","lib.es2020.symbol.wellknown.d.ts","lib.es5.d.ts","lib.scripthost.d.ts","lib.webworker.importscripts.d.ts"]);
const BROAD_POSITIVE_SOURCE = Object.freeze({"sourceId":"VIRTUAL_BROAD_LIBRARY_POSITIVE.ts","text":"export const fixtureSet: Set<number> = new Set<number>([1]);\nexport const fixturePromise: Promise<number> = Promise.resolve(1);\nexport const fixtureArray: number[] = Array.of(1, 2);\nexport const fixtureKeys: string[] = Object.keys({ a: 1 });\n"});
const BROAD_NEGATIVE_SOURCE = Object.freeze({"sourceId":"VIRTUAL_BROAD_LIBRARY_NEGATIVE.ts","text":"export const fixtureWrong: number = \"fixed-wrong\";\n"});

function createBroadLibraryAdmission(sourceRoot, runtimeRoot, options) {
  const libraryRoot = path.join(runtimeRoot, 'node_modules/typescript/lib');
  const libraryIds = BROAD_DEFAULT_LIBRARY_NAMES.map(name => 'node_modules/typescript/lib/' + name);
  const report = { schema: 'SD-COMPILER-LIBRARY-ADMISSION-1', status: 'FAIL', compiler: ts.version,
    compilerSha256: INDEX_COMPILER_SHA, options: { ...options, types: options.types.slice() },
    semanticProgram: { programFiles: [], libraryFiles: {} }, positive: null, negative: null,
    oldHostControl: null, restoredPositive: null };
  function fail() {
    // Only fixed/public IDs, hashes and diagnostic metadata enter this report.
    const serialized = JSON.stringify({ schema: 'SD-COMPILER-LIBRARY-FAILURE-1', report });
    if (Buffer.byteLength(serialized, 'utf8') <= 2 * 1024 * 1024) process.stdout.write(serialized + '\n');
    else process.stdout.write(JSON.stringify({ schema: 'SD-COMPILER-LIBRARY-FAILURE-1',
      report: { status: 'FAIL', code: 'BROAD_LIBRARY_REPORT_LIMIT' } }) + '\n');
    throw new Error('BROAD_LIBRARY_ADMISSION_FAILED');
  }
  function regular(file) {
    const metadata = fs.lstatSync(file);
    requireThat(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
      && fs.realpathSync(file) === file, 'BROAD_LIBRARY_INPUT_REGULAR');
    return fs.readFileSync(file);
  }
  function libraryName(file) {
    const absolute = path.resolve(file);
    if (path.dirname(absolute) !== libraryRoot || !path.basename(absolute).startsWith('lib.')
      || !path.basename(absolute).endsWith('.d.ts')) return null;
    const name = path.basename(absolute);
    requireThat(Object.hasOwn(BROAD_LIBRARY_HASHES, name), 'BROAD_LIBRARY_UNDECLARED_INPUT'); return name;
  }
  function admittedLibrary(file) {
    const absolute = path.resolve(file); const name = libraryName(absolute);
    requireThat(name !== null, 'BROAD_LIBRARY_INPUT_LOCATION'); const data = regular(absolute);
    requireThat(sha(data) === BROAD_LIBRARY_HASHES[name], 'BROAD_LIBRARY_INPUT_HASH'); return data.toString('utf8');
  }
  function sourceId(file, virtual) {
    const absolute = path.resolve(file);
    if (virtual && absolute === virtual.filename) return virtual.sourceId;
    if (absolute.startsWith(sourceRoot + path.sep)) return path.relative(sourceRoot, absolute).split(path.sep).join('/');
    if (absolute.startsWith(runtimeRoot + path.sep)) return path.relative(runtimeRoot, absolute).split(path.sep).join('/');
    return 'UNDECLARED_SOURCE';
  }
  function inspect(program, virtual) {
    const files = program.getSourceFiles();
    requireThat(files.length <= 4096, 'BROAD_LIBRARY_PROGRAM_LIMIT');
    const used = {}; const programFiles = [];
    for (const file of files) {
      const id = sourceId(file.fileName, virtual);
      requireThat(id !== 'UNDECLARED_SOURCE' && id.length <= 256, 'BROAD_LIBRARY_PROGRAM_SOURCE'); programFiles.push(id);
      const name = libraryName(file.fileName);
      requireThat(!program.isSourceFileDefaultLibrary(file) || name !== null, 'BROAD_LIBRARY_INPUT_LOCATION');
      if (name !== null) { admittedLibrary(file.fileName); used[name] = BROAD_LIBRARY_HASHES[name]; }
    }
    requireThat(new Set(programFiles).size === programFiles.length, 'BROAD_LIBRARY_PROGRAM_SOURCE');
    return { programFiles: programFiles.sort(), libraryFiles: Object.fromEntries(Object.entries(used).sort(([left], [right]) => left.localeCompare(right))) };
  }
  function metadata(item, virtual) {
    const raw = ts.flattenDiagnosticMessageText(item.messageText, '\n');
    let message = 'PUBLIC_COMPILER_DIAGNOSTIC';
    if (item.code === 2318 && /^Cannot find global type '(?:Array|Boolean|CallableFunction|Function|IArguments|NewableFunction|Number|Object|RegExp|String)'\.$/.test(raw)) message = raw;
    if (item.code === 2322 && raw === "Type 'string' is not assignable to type 'number'.") message = raw;
    return { sourceId: item.file ? sourceId(item.file.fileName, virtual) : null,
      code: item.code, category: item.category, start: item.start === undefined ? null : item.start,
      length: item.length === undefined ? null : item.length, message };
  }
  function probe(host, selected) {
    const virtual = { filename: path.join(runtimeRoot, selected.sourceId), sourceId: selected.sourceId };
    const row = { sourceId: selected.sourceId, sourceSha256: sha(Buffer.from(selected.text)), status: 'EXCEPTION',
      programFiles: [], libraryFiles: {}, diagnostics: [] };
    // Every other host operation is exactly the corrected broad host operation.
    // Only these two fixed in-memory virtual source names/texts are served here.
    const probeHost = { ...host,
      fileExists: file => path.resolve(file) === virtual.filename || host.fileExists(file),
      readFile: file => path.resolve(file) === virtual.filename ? selected.text : host.readFile(file),
      getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile) {
        if (path.resolve(file) === virtual.filename) return ts.createSourceFile(file, selected.text, languageVersion, true);
        return host.getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
      },
    };
    try {
      const program = ts.createProgram([virtual.filename], options, probeHost);
      const actual = ts.getPreEmitDiagnostics(program);
      requireThat(actual.length <= 256, 'BROAD_LIBRARY_DIAGNOSTIC_LIMIT');
      row.diagnostics = actual.map(item => metadata(item, virtual));
      const observed = inspect(program, virtual); row.programFiles = observed.programFiles; row.libraryFiles = observed.libraryFiles;
      row.status = 'COMPLETE';
    } catch { /* A compiler exception remains EXCEPTION, never a detected control. */ }
    return row;
  }
  function sameLibraries(row) {
    return JSON.stringify(Object.keys(row.libraryFiles).sort()) === JSON.stringify(BROAD_DEFAULT_LIBRARY_NAMES)
      && BROAD_DEFAULT_LIBRARY_NAMES.every(name => row.libraryFiles[name] === BROAD_LIBRARY_HASHES[name]);
  }
  function positivePredicate(row) {
    const sourceId = BROAD_POSITIVE_SOURCE.sourceId;
    return row.status === 'COMPLETE' && row.diagnostics.length === 0 && sameLibraries(row)
      && JSON.stringify(row.programFiles) === JSON.stringify([...libraryIds, sourceId].sort());
  }
  function guarded(action) { try { return action(); } catch { return fail(); } }
  return Object.freeze({
    read(file, inheritedRead) {
      const name = libraryName(file);
      return name === null ? inheritedRead(file) : admittedLibrary(file);
    },
    createProgram(action) {
      return guarded(() => {
        requireThat(ts.version === '5.9.3' && sha(regular(path.join(libraryRoot, 'typescript.js'))) === INDEX_COMPILER_SHA,
          'BROAD_LIBRARY_COMPILER');
        const program = action(); report.semanticProgram = inspect(program); return program;
      });
    },
    getDiagnostics: action => guarded(action),
    check(host, inheritedGetDefaultLibLocation) {
      return guarded(() => {
        const correctedLocation = host.getDefaultLibLocation;
        requireThat(typeof correctedLocation === 'function' && typeof inheritedGetDefaultLibLocation === 'function'
          && correctedLocation() === libraryRoot, 'BROAD_LIBRARY_HOST_LOCATION');
        report.positive = probe(host, BROAD_POSITIVE_SOURCE);
        requireThat(positivePredicate(report.positive), 'BROAD_LIBRARY_POSITIVE');
        report.negative = probe(host, BROAD_NEGATIVE_SOURCE);
        const negative = report.negative; const diagnostic = negative.diagnostics[0];
        requireThat(negative.status === 'COMPLETE' && negative.diagnostics.length === 1 && sameLibraries(negative)
          && JSON.stringify(negative.programFiles) === JSON.stringify([...libraryIds, BROAD_NEGATIVE_SOURCE.sourceId].sort())
          && diagnostic.sourceId === BROAD_NEGATIVE_SOURCE.sourceId && diagnostic.code === 2322 && diagnostic.category === 1
          && diagnostic.start === 13 && diagnostic.length === 12, 'BROAD_LIBRARY_NEGATIVE');
        try { host.getDefaultLibLocation = inheritedGetDefaultLibLocation; report.oldHostControl = probe(host, BROAD_POSITIVE_SOURCE); }
        finally { host.getDefaultLibLocation = correctedLocation; }
        requireThat(host.getDefaultLibLocation === correctedLocation && report.oldHostControl.status === 'COMPLETE'
          && !positivePredicate(report.oldHostControl) && !sameLibraries(report.oldHostControl)
          && report.oldHostControl.diagnostics.some(diagnostic => diagnostic.code === 2318 && diagnostic.message === "Cannot find global type 'Array'."),
        'BROAD_LIBRARY_PRIOR_HOST_CONTROL');
        report.restoredPositive = probe(host, BROAD_POSITIVE_SOURCE);
        requireThat(positivePredicate(report.restoredPositive), 'BROAD_LIBRARY_RESTORED_POSITIVE');
        report.status = 'PASS'; return report;
      });
    },
  });
}

function assertModelDeclarations(declarations, models) {
  const select = rows => rows.map(row => ({ name: row.name, source: row.source }))
    .sort((a, b) => a.name.localeCompare(b.name));
  requireThat(Array.isArray(models) && models.length > 0
    && new Set(models.map(row => row.name)).size === models.length, 'DUPLICATE_DECLARED_MODEL');
  requireThat(new Set(declarations.map(row => row.name)).size === declarations.length, 'DUPLICATE_EMITTED_MODEL');
  requireThat(JSON.stringify(select(declarations)) === JSON.stringify(select(models)), 'EMITTED_MODEL_MANIFEST_MISMATCH');
}

// Parse emitted nominal CommonJS as data. Follow actual literal require edges,
// including erased-import differences, without requiring any domain module.
function inspectEmittedModels(runtimeRoot, modules, ports) {
  const excluded = new Set([...Object.keys(ports.excludedCapabilities), ...ports.recordingModules]);
  const reachable = new Set(); const declarations = []; const queue = ports.roots.map(alias => modules[alias]);
  const sourceFor = file => 'src1/' + file.slice('compiled/'.length, -3) + '.ts';
  const unwrap = expression => {
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) return unwrap(expression.right);
    return expression;
  };
  function requiredName(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      requireThat(node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]), 'DYNAMIC_DOMAIN_REQUIRE');
      return node.arguments[0].text;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ['__importDefault', '__importStar'].includes(node.expression.text) && node.arguments.length === 1)
      return requiredName(node.arguments[0]);
    return undefined;
  }
  while (queue.length) {
    const file = queue.shift(); if (reachable.has(file)) continue;
    requireThat(typeof file === 'string' && file.startsWith('compiled/') && !file.startsWith('compiled/mutants/'), 'MODEL_AUDIT_SOURCE');
    reachable.add(file);
    const ast = ts.createSourceFile(file, fs.readFileSync(path.join(runtimeRoot, file), 'utf8'), ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
    const mongooseBindings = new Set();
    function bindings(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && requiredName(node.initializer) === 'mongoose') mongooseBindings.add(node.name.text);
      ts.forEachChild(node, bindings);
    }
    bindings(ast);
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const request = requiredName(node);
        if (request && !excluded.has(request)) {
          if (request.startsWith('@/')) { requireThat(modules[request], 'MODEL_AUDIT_UNKNOWN_ALIAS'); queue.push(modules[request]); }
          else if (request.startsWith('.')) {
            const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), request));
            const target = [base + '.js', base + '/index.js'].find(candidate => Object.values(modules).includes(candidate));
            requireThat(target, 'MODEL_AUDIT_UNKNOWN_RELATIVE'); queue.push(target);
          }
        }
        const expression = unwrap(node.expression);
        if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'model' && node.arguments.length >= 2) {
          let receiver = expression.expression;
          if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'default') receiver = receiver.expression;
          if (ts.isIdentifier(receiver) && mongooseBindings.has(receiver.text)) {
            requireThat(ts.isStringLiteralLike(node.arguments[0]), 'DYNAMIC_MODEL_DECLARATION');
            declarations.push({ name: node.arguments[0].text, source: sourceFor(file), compiled: file });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  declarations.sort((a, b) => a.name.localeCompare(b.name));
  assertModelDeclarations(declarations, ports.models);
  requireThat(declarations.length === 13 && ports.models.length === 13, 'AUTHORITY_MODEL_COUNT');
  // Genuine guard sensitivity runs only in the separately approved compiler
  // invocation. These variants change metadata, never production source or DB.
  const controls = [];
  const expectRejected = (id, candidate) => {
    let rejected = false; try { assertModelDeclarations(declarations, candidate); } catch { rejected = true; }
    requireThat(rejected, 'MODEL_AUDIT_CONTROL_SURVIVED'); controls.push({ id, rejected: true });
  };
  expectRejected('OMITTED_WELLNESS_PACKAGE', ports.models.filter(row => row.name !== 'WellnessPackage'));
  expectRejected('EXTRA_UNREACHABLE_MODEL', [...ports.models, { name: 'UnreachableFixtureModel', source: 'src1/unreachable.ts' }]);
  expectRejected('DUPLICATE_MODEL', [...ports.models, ports.models[0]]);
  expectRejected('WRONG_MODEL_SOURCE', ports.models.map((row, index) => index === 0 ? { ...row, source: 'src1/wrong.ts' } : row));
  expectRejected('OMITTED_DEPENDENT', ports.models.filter(row => row.name !== 'Dependent'));
  return { declarations, audit: { status: 'STATIC_EMITTED_MODEL_MAP_VERIFIED', reachableModules: reachable.size,
    modelCount: declarations.length, controls, applicationEvaluations: 0 } };
}

function compile(sourceRoot, runtimeRoot, inputPlan) {
  const ports = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'ports-manifest.json'), 'utf8'));
  const tracked = new Set(inputPlan.trackedSources);
  const excluded = new Set([...Object.keys(ports.excludedCapabilities), ...ports.recordingModules]);
  const modules = {}; const sources = {}; const queue = [...ports.roots];
  const diagnostics = [];
  const externalRoots = new Set(Object.keys(inputPlan.packageVersions));
  function resolveAlias(request, from) {
    if (excluded.has(request)) return null;
    let relative;
    if (request.startsWith('@/')) relative = 'src1/' + request.slice(2);
    else if (request.startsWith('.')) relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), request));
    else return null;
    requireThat(relative.startsWith('src1/') && !relative.includes('..'), 'SOURCE_ESCAPE');
    const found = [relative + '.ts', relative + '/index.ts'].find(name => tracked.has(name));
    requireThat(found, 'UNRESOLVED_SOURCE:' + relative);
    return found;
  }
  function emit(relative, text, output) {
    const result = ts.transpileModule(text, {
      fileName: relative,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true, emitDecoratorMetadata: true,
        esModuleInterop: true, importHelpers: false, sourceMap: false,
      },
    });
    for (const item of result.diagnostics || []) diagnostics.push({ file: relative, code: item.code, category: item.category,
      message: ts.flattenDiagnosticMessageText(item.messageText, '\n') });
    requireThat(!(result.diagnostics || []).some(item => item.category === ts.DiagnosticCategory.Error), 'TRANSPILATION_DIAGNOSTIC');
    fs.mkdirSync(path.dirname(path.join(runtimeRoot, output)), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, output), result.outputText);
  }
  while (queue.length) {
    const item = queue.shift();
    if (excluded.has(item)) continue;
    const relative = item.startsWith('src1/') ? item : resolveAlias(item, 'src1/index.ts');
    requireThat(relative, 'UNDECLARED_SOURCE_ROOT');
    if (sources[relative]) continue;
    const absolute = path.join(sourceRoot, relative);
    const metadata = fs.lstatSync(absolute);
    requireThat(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, 'NONREGULAR_SOURCE');
    const bytes = fs.readFileSync(absolute); const text = bytes.toString('utf8');
    const output = 'compiled/' + relative.slice(5, -3) + '.js';
    sources[relative] = sha(bytes);
    const alias = '@/' + relative.slice(5, -3).replace(/\/index$/, '');
    modules[alias] = output;
    modules['@/' + relative.slice(5, -3)] = output;
    const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.ES2020, true);
    for (const statement of ast.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
        const request = statement.moduleSpecifier.text;
        if (excluded.has(request)) continue;
        if (request.startsWith('@/') || request.startsWith('.')) queue.push(resolveAlias(request, relative));
        else if (!request.startsWith('node:') && !['crypto', 'path', 'fs', 'stream', 'util'].includes(request)) {
          const root = request.startsWith('@') ? request.split('/').slice(0, 2).join('/') : request.split('/')[0];
          requireThat(externalRoots.has(root), 'UNREVIEWED_PACKAGE:' + root);
        }
      }
    }
    emit(relative, text, output);
  }
  const modelMap = inspectEmittedModels(runtimeRoot, modules, ports);
  requireThat(sources[INDEX_HELPER_SOURCE] === INDEX_HELPER_SHA, 'INDEX_SOURCE_PIN');
  const indexTypecheck = selectedHelperTypecheck(sourceRoot, runtimeRoot,
    fs.readFileSync(path.join(sourceRoot, INDEX_HELPER_SOURCE), 'utf8'));
  const mutants = {};
  function mutate(id, relative, transform) {
    requireThat(Object.hasOwn(sources, relative), 'MUTANT_SOURCE_NOT_ADMITTED');
    const original = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
    const changed = transform(original);
    requireThat(changed !== original, 'EMPTY_MUTANT');
    const output = 'compiled/mutants/' + id + '.js';
    emit(relative, changed, output);
    mutants[id] = { source: relative, originalSha256: sources[relative], mutantSha256: sha(Buffer.from(changed)), file: output };
  }
  mutate('OTP_UNCONDITIONAL_CONSUME', 'src1/modules/otp/repository/index.ts', text => once(text, `      {
        _id: otpId,
        userId: data.userId,
        otp: data.otp,
        target: data.target,
        targetValue: data.targetValue,
        isVerified: false,
        expireAt: { $eq: observedExpiry, $gt: consumeCheckpoint },
      },`, '      { _id: otpId },'));
  mutate('OTP_LOGIN_TARGET_UNBOUND', 'src1/modules/auth/services/index.ts', text => {
    const start = text.indexOf("    // Verify OTP against the selected identity's current destination.");
    const end = text.indexOf('    // Create wallet for regular users', start);
    requireThat(start > 0 && end > start, 'LOGIN_MUTANT_BOUNDARY');
    return text.slice(0, start) + once(text.slice(start, end), '      target,\n      targetValue,\n    });', '      target,\n    });') + text.slice(end);
  });
  mutate('USER_OTHER_READ', 'src1/modules/user/controller/index.ts', text => {
    const ast = ts.createSourceFile('user.ts', text, ts.ScriptTarget.ES2020, true);
    const klass = ast.statements.find(statement => ts.isClassDeclaration(statement) && statement.name.text === 'UserController');
    const method = klass.members.find(member => member.name && member.name.getText(ast) === 'assertUserRouteActor');
    requireThat(method && method.body, 'USER_MUTANT_BOUNDARY');
    return text.slice(0, method.body.pos) + ' { return; }' + text.slice(method.body.end);
  });
  mutate('WALLET_OTHER_READ', 'src1/modules/wallet/controller/index.ts', text => {
    const ast = ts.createSourceFile('wallet.ts', text, ts.ScriptTarget.ES2020, true);
    const klass = ast.statements.find(statement => ts.isClassDeclaration(statement) && statement.name.text === 'WalletController');
    const member = klass.members.find(property => property.name && property.name.getText(ast) === 'getById');
    const remove = member.initializer.body.statements.filter(statement => ts.isIfStatement(statement));
    requireThat(remove.length === 2, 'WALLET_MUTANT_BOUNDARY');
    for (const statement of remove.reverse()) text = text.slice(0, statement.pos) + text.slice(statement.end);
    return text;
  });
  function memberText(text, className, memberName, transform) {
    const ast = ts.createSourceFile('authority.ts', text, ts.ScriptTarget.ES2020, true);
    const klass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
    const member = klass?.members.find(node => node.name?.getText(ast) === memberName);
    requireThat(member, 'AUTHORITY_MUTANT_MEMBER');
    const original = text.slice(member.pos, member.end); const changed = transform(original);
    requireThat(changed !== original, 'AUTHORITY_MUTANT_MEMBER_UNCHANGED');
    return text.slice(0, member.pos) + changed + text.slice(member.end);
  }
  const dependentController = 'src1/modules/dependents/controller/index.ts';
  const notificationController = 'src1/modules/notification/controller/index.ts';
  const fcmRoutes = 'src1/modules/fcm/routes/index.ts';
  mutate('DEPENDENT_UNBOUND_CREATE_OWNER', dependentController, text => memberText(text, 'DependentController', 'create', source => {
    const ast = ts.createSourceFile('dependent.ts', text, ts.ScriptTarget.ES2020, true);
    const klass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'DependentController');
    const member = klass.members.find(node => node.name?.getText(ast) === 'create');
    const guards = member.initializer.body.statements.filter(ts.isIfStatement);
    requireThat(guards.length === 1, 'DEPENDENT_CREATE_MUTANT_BOUNDARY');
    const start = guards[0].pos - member.pos; const end = guards[0].end - member.pos;
    return once(source.slice(0, start) + source.slice(end),
      "userId: actor.userType === 'admin' ? req.body.userId : actor._id,", 'userId: req.body.userId,');
  }));
  mutate('DEPENDENT_UNSCOPED_LIST', dependentController, text => memberText(text, 'DependentController', 'getAll', source => once(source,
    'const effectiveUserId = this.resolveOwner(req, req.query.userId as string | undefined);',
    'const effectiveUserId = req.query.userId as string | undefined;')));
  mutate('DEPENDENT_UNSCOPED_ID_CALLS', dependentController, text => {
    for (const name of ['getById', 'update', 'delete']) text = memberText(text, 'DependentController', name, source => once(source,
      'const userId = this.resolveOwner(req, req.query.userId as string | undefined);',
      'const userId = req.query.userId as string | undefined;'));
    return text;
  });
  mutate('DEPENDENT_FORBIDDEN_ROLE_ADMISSION', dependentController, text => memberText(text, 'DependentController', 'requireActor', source => once(source,
    "if (actor.userType !== 'user' && actor.userType !== 'admin')", 'if (false)')));
  mutate('DEPENDENT_RAW_OWNER_STRIPPED', 'src1/modules/dependents/routes/index.ts', text => once(text,
    "  catchAsync(dependentController.rejectOwnershipChange),\n  validate(updateDependentSchema, 'body'),",
    "  validate(updateDependentSchema, 'body'),\n  catchAsync(dependentController.rejectOwnershipChange),"));
  mutate('NOTIFICATION_UNSCOPED_LIST', notificationController, text => memberText(text, 'NotificationController', 'getAll', source => once(source,
    'userId: this.resolveListRecipient(req),', 'userId: req.query.userId as string | undefined,')));
  mutate('NOTIFICATION_ID_OWNER_GUARD_REMOVED', notificationController, text => memberText(text, 'NotificationController', 'getAuthorizedNotification', source => once(source,
    "    if (actor.userType !== 'admin') {\n      this.assertOwnRecipient(req, notification.userId);\n    }", '')));
  mutate('NOTIFICATION_PRIOR_STRICT_OWN_ADMIN_EXPANSION', notificationController, text => memberText(text, 'NotificationController', 'assertOwnRecipient', source => once(source,
    'private assertOwnRecipient(req: AuthRequest, userId: string): void {',
    "private assertOwnRecipient(req: AuthRequest, userId: string): void {\n    if (req.user?.userType === 'admin') return;")));
  const testRegistration = "  '/test',\n  requireAdmin,\n  validate(sendTestNotificationSchema, 'body'),";
  mutate('FCM_TEST_ADMIN_GUARD_REMOVED', fcmRoutes, text => once(text, testRegistration,
    "  '/test',\n  validate(sendTestNotificationSchema, 'body'),"));
  mutate('FCM_TEST_ADMIN_GUARD_AFTER_VALIDATION', fcmRoutes, text => once(text, testRegistration,
    "  '/test',\n  validate(sendTestNotificationSchema, 'body'),\n  requireAdmin,"));
  const configSource = 'src1/config/config.ts';
  const configInitializer = '  JWT_SECRET_KEY: requireJwtSecret(process.env.JWT_SECRET_KEY),';
  mutate('JWT_CONFIG_PUBLISHED_FALLBACK', configSource, text => once(text, configInitializer,
    "  JWT_SECRET_KEY: process.env.JWT_SECRET_KEY || 'your-secret-key',"));
  mutate('JWT_CONFIG_PRODUCTION_ONLY_GUARD', configSource, text => once(text, configInitializer,
    "  JWT_SECRET_KEY: process.env.NODE_ENV === 'production' ? requireJwtSecret(process.env.JWT_SECRET_KEY) : process.env.JWT_SECRET_KEY,"));
  mutate('JWT_CONFIG_TRIMMED_RETURN', configSource, text => once(text, '  return value;\n}', '  return value.trim();\n}'));
  const meetSourcePins = {
    'src1/modules/meet/routes/index.ts': 'e8bfff4a492ed11a18f1735528bfa4886a338b878852cde9bcea2f5d5bdd71e4',
    'src1/modules/meet/controller/index.ts': '94b5d080c86ed8b9bb0f1ba4a145ed67d9e51115bbb10e26013a30026bf7aff0',
    'src1/modules/meet/validation/index.ts': '8543aad3ebb22beabe3e293e278154edda82b47d80dc1b1aa379854260e428a7',
    'src1/modules/meet/service/index.ts': 'edc6972866223a641027fcddc3b1b3bcec47bb31cb189bf4d7b097da33a24644',
    'src1/modules/meet/types/index.ts': 'c2073614952f0d411bacd59896d386df54d8d8310c20234b4ab30eec35bfd863',
  };
  for (const [source, hash] of Object.entries(meetSourcePins)) requireThat(sources[source] === hash, 'MEET_SOURCE_PIN');
  const meetRoutes = 'src1/modules/meet/routes/index.ts';
  const protectedMeet = [['/google-oauth/url', 'googleOAuthQuerySchema', 'query'],
    ['/google-oauth/exchange', 'googleOAuthExchangeSchema', 'body'],
    ['/google-oauth/refresh', 'googleOAuthRefreshTestSchema', 'body'],
    ['/google-meet/oauth', 'testGoogleMeetSchema', 'body']];
  function changeMeetGuards(text, kind) {
    for (const [route, schema, area] of protectedMeet) {
      const start = `  '${route}',\n`;
      const validation = `  validate(${schema}, '${area}'),`;
      const before = start + '  authenticate,\n  requireAdmin,\n' + validation;
      const after = kind === 'authentication' ? start + '  requireAdmin,\n' + validation
        : kind === 'admin' ? start + '  authenticate,\n' + validation
          : start + validation + '\n  authenticate,\n  requireAdmin,';
      text = once(text, before, after);
    }
    return text;
  }
  mutate('MEET_AUTHENTICATION_REMOVED', meetRoutes, text => changeMeetGuards(text, 'authentication'));
  mutate('MEET_ADMIN_GUARD_REMOVED', meetRoutes, text => changeMeetGuards(text, 'admin'));
  mutate('MEET_GUARDS_AFTER_VALIDATION', meetRoutes, text => changeMeetGuards(text, 'validation'));
  mutate('MEET_CALLBACK_GATED', meetRoutes, text => once(text,
    "  '/google-oauth/callback',\n  validate(googleOAuthCallbackQuerySchema, 'query'),",
    "  '/google-oauth/callback',\n  authenticate,\n  requireAdmin,\n  validate(googleOAuthCallbackQuerySchema, 'query'),"));
  mutate("INDEX_MISSING_REQUIREMENT_ACCEPTED", INDEX_HELPER_SOURCE, text => {
    const changed = once(text, "return makeResult(\"REQUIRED_INDEX_UNSATISFIED\", collectionOrdinal, indexOrdinal);", "return makeResult(\"READY\");");
    requireThat(sha(Buffer.from(changed)) === "38840d330b825e2feb7240b73845ca11728cf516f4853d89e6e5e6d3ce6438f6", 'INDEX_MUTANT_SOURCE_HASH');
    return changed;
  });
  mutate("INDEX_KEY_ORDER_IGNORED", INDEX_HELPER_SOURCE, text => {
    const changed = once(text, "return left.length === right.length && right.every((entry, index) =>\n        left[index][0] === entry[0] && left[index][1] === entry[1]);", "return left.length === right.length && right.every((entry) =>\n        left.some((candidate) => candidate[0] === entry[0] && candidate[1] === entry[1]));");
    requireThat(sha(Buffer.from(changed)) === "03cedbf95c229c2bcacb4aa5913bc6b723b6dcaab10cab24d9dfd68278cca2d9", 'INDEX_MUTANT_SOURCE_HASH');
    return changed;
  });
  mutate("INDEX_OPTIONS_IGNORED", INDEX_HELPER_SOURCE, text => {
    const changed = once(text, "        observed.hidden || requirement.unique !== observed.unique || requirement.sparse !== observed.sparse ||\n        requirement.ttl !== observed.ttl || requirement.partialPresent !== observed.partialPresent) return false;", "        requirement.partialPresent !== observed.partialPresent) return false;");
    requireThat(sha(Buffer.from(changed)) === "cba386c2e53905dc8ef137d33a03c9ddc6841456addcf18d4539854664b1ad9c", 'INDEX_MUTANT_SOURCE_HASH');
    return changed;
  });
  mutate("INDEX_PARTIAL_FILTER_IGNORED", INDEX_HELPER_SOURCE, text => {
    const changed = once(text, "return !requirement.partialPresent || equalJson(requirement.partial, observed.partial);", "return true;");
    requireThat(sha(Buffer.from(changed)) === "37cc8f34866d598d7c2474627992c35eaf0e2fb3949386fc0bc0c22bd9bddb40", 'INDEX_MUTANT_SOURCE_HASH');
    return changed;
  });
  mutate("INDEX_INCOMPLETE_ACCEPTED", INDEX_HELPER_SOURCE, text => {
    const changed = once(text, "if (listing.status === \"INCOMPLETE\") return makeResult(\"OBSERVATION_INCOMPLETE\", collectionOrdinal);", "if (listing.status === \"INCOMPLETE\") return makeResult(\"READY\");");
    requireThat(sha(Buffer.from(changed)) === "be8b32e10a16334d68b8df8cfa0b55d5ffbaf161d826261366f6adbc8a8ab150", 'INDEX_MUTANT_SOURCE_HASH');
    return changed;
  });
  mutate("INDEX_BUILD_STATUS_IGNORED", INDEX_HELPER_SOURCE, text => {
    const changed = once(text, "if (listing.building) return makeResult(\"OBSERVATION_UNREADY\", collectionOrdinal);", "if (listing.building) return makeResult(\"READY\");");
    requireThat(sha(Buffer.from(changed)) === "a72e944ce170bbc8d6b68ce19ec2628bbfc4d86ba19be24e0aa19e219710104c", 'INDEX_MUTANT_SOURCE_HASH');
    return changed;
  });
  requireThat(JSON.stringify(Object.keys(mutants)) === JSON.stringify(ports.requiredSensitivityIds), 'MUTANT_SET');
  // Retain focused semantic diagnostics without evaluating any application
  // module or resolving excluded capabilities into the rest of the monolith.
  // Missing declarations/excluded types remain visible diagnostic failures.
  const options = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true, noEmit: true,
    skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const fileExists = host.fileExists; const readFile = host.readFile;
  const sourcePaths = new Set(Object.keys(sources).map(name => path.join(sourceRoot, name)));
  const typeRoot = path.join(runtimeRoot, 'node_modules') + path.sep;
  const libraryRoot = path.join(typeRoot, 'typescript/lib');
  const inheritedGetDefaultLibLocation = host.getDefaultLibLocation;
  const libraryAdmission = createBroadLibraryAdmission(sourceRoot, runtimeRoot, options);
  const allowedTypeFile = file => sourcePaths.has(path.resolve(file)) || path.resolve(file).startsWith(typeRoot);
  host.fileExists = file => allowedTypeFile(file) && fileExists(file);
  host.readFile = file => allowedTypeFile(file) ? libraryAdmission.read(file, readFile) : undefined;
  host.getSourceFile = (file, languageVersion, onError) => {
    const text = host.readFile(file);
    if (text === undefined) { if (onError) onError('DECLARED_TYPE_INPUT_UNAVAILABLE'); return undefined; }
    return ts.createSourceFile(file, text, languageVersion, true);
  };
  host.getCurrentDirectory = () => runtimeRoot;
  host.getDefaultLibFileName = () => path.join(typeRoot, 'typescript/lib/lib.es2020.full.d.ts');
  host.getDefaultLibLocation = () => libraryRoot;
  host.resolveModuleNames = (names, containingFile) => names.map(request => {
    if (excluded.has(request)) return undefined;
    if (sourcePaths.has(containingFile) && (request.startsWith('@/') || request.startsWith('.'))) {
      const relative = resolveAlias(request, path.relative(sourceRoot, containingFile).split(path.sep).join('/'));
      const absolute = relative && path.join(sourceRoot, relative);
      requireThat(sourcePaths.has(absolute), 'SEMANTIC_SOURCE_OUTSIDE_CLOSURE');
      return { resolvedFileName: absolute, extension: ts.Extension.Ts, isExternalLibraryImport: false };
    }
    const from = sourcePaths.has(containingFile) ? path.join(runtimeRoot, '__public_types__.ts') : containingFile;
    return ts.resolveModuleName(request, from, options, host).resolvedModule;
  });
  const program = libraryAdmission.createProgram(() => ts.createProgram([...sourcePaths], options, host));
  const semanticDiagnostics = libraryAdmission.getDiagnostics(() => ts.getPreEmitDiagnostics(program)).map(item => ({
    file: item.file ? path.relative(sourceRoot, item.file.fileName).split(path.sep).join('/') : null,
    code: item.code, category: item.category, message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
  }));
  const broadLibraryReport = libraryAdmission.check(host, inheritedGetDefaultLibLocation);
  const plan = { schema: 'SD-AUTH-API-PLAN-1', role: ports.role, sourceCommit: inputPlan.sourceCommit, sourceFiles: sources,
    modules, mutants, models: ports.models, modelDeclarations: modelMap.declarations, modelMapAudit: modelMap.audit,
    packageVersions: inputPlan.packageVersions, lockSha: inputPlan.lockSha,
    portsSha: inputPlan.portsSha, requiredCaseIds: ports.requiredCaseIds,
    requiredSensitivityIds: ports.requiredSensitivityIds, providerCounterKeys: ports.providerCounterKeys,
    providerCounterScope: 'NOMINAL_ONLY_EXCLUDING_EXPLICIT_SENSITIVITY_PHASES',
    compilation: { status: 'TRANSPILE_ONLY_NOT_TYPECHECKED', compiler: ts.version, diagnostics,
      semanticDiagnostics, semanticScope: 'DECLARED_CLOSURE_AND_PUBLIC_TYPES_WITH_EXCLUDED_CAPABILITIES_UNRESOLVED', fullBuild: false,
      selectedHelperTypecheck: indexTypecheck, libraryAdmission: broadLibraryReport } };
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

if (require.main === module) {
  requireThat(process.argv.length === 5, 'COMPILER_INVOCATION');
  const input = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  compile(process.argv[2], process.argv[3], input);
}
module.exports = { compile };
