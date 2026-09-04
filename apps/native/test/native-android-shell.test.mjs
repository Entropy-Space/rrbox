import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const androidRoot = new URL("../src-tauri/gen/android/", import.meta.url);
const readAndroid = (path) => readFile(new URL(path, androidRoot), "utf8");
const [manifest, appBuild, rootBuild, pluginBuild, wrapper, properties, activity, application, nativeTls, proguard, buildTask] =
  await Promise.all([
    readAndroid("app/src/main/AndroidManifest.xml"),
    readAndroid("app/build.gradle.kts"),
    readAndroid("build.gradle.kts"),
    readAndroid("buildSrc/build.gradle.kts"),
    readAndroid("gradle/wrapper/gradle-wrapper.properties"),
    readAndroid("gradle.properties"),
    readAndroid("app/src/main/java/dev/tokn_ai/rrbox/MainActivity.kt"),
    readAndroid("app/src/main/java/dev/tokn_ai/rrbox/RrboxApplication.kt"),
    readFile(new URL("../src-tauri/src/android.rs", import.meta.url), "utf8"),
    readAndroid("app/proguard-rules.pro"),
    readAndroid("buildSrc/src/main/java/dev/tokn_ai/rrbox/kotlin/BuildTask.kt"),
  ]);

test("Android pins a consistent AGP 9.3 and Java-25-compatible Gradle toolchain", () => {
  assert.match(rootBuild, /com\.android\.tools\.build:gradle:9\.3\.2/u);
  assert.match(pluginBuild, /com\.android\.tools\.build:gradle:9\.3\.2/u);
  assert.match(wrapper, /gradle-9\.5\.0-bin\.zip/u);
  assert.match(wrapper, /^distributionSha256Sum=[a-f0-9]{64}$/mu);
  assert.doesNotMatch(properties, /^android\.(builtInKotlin|newDsl)=false$/mu);
  assert.doesNotMatch(appBuild, /kotlinOptions|org\.jetbrains\.kotlin\.android/u);
  assert.match(appBuild, /compilerOptions/u);
  assert.match(buildTask, /ExecOperations/u);
  assert.doesNotMatch(buildTask, /project\.exec/u);
});

test("Android builds Cargo-locked Tauri sources through a local modern-DSL adapter", async () => {
  const settings = await readAndroid("settings.gradle");
  const adapter = await readAndroid("tauri-android/build.gradle.kts");
  assert.match(settings, /apply from: 'tauri\.settings\.gradle'/u);
  assert.match(settings, /tauriAndroidSourceDir = tauriAndroid\.projectDir/u);
  assert.match(settings, /tauriAndroid\.projectDir = file\('tauri-android'\)/u);
  assert.match(adapter, /tauriSourceDir\.resolve\("src\/main\/java"\)/u);
  assert.match(adapter, /consumerProguardFiles\(tauriSourceDir\.resolve/u);
  assert.match(adapter, /check\(upstreamBuildHash == "[a-f0-9]{64}"\)/u);
  assert.match(adapter, /compilerOptions/u);
  assert.doesNotMatch(adapter, /kotlinOptions|org\.jetbrains\.kotlin\.android/u);
});

test("Android preserves the package identity and keeps credentials out of backups", async () => {
  assert.match(appBuild, /applicationId = "dev\.tokn_ai\.rrbox"/u);
  assert.match(appBuild, /minSdk = 24/u);
  assert.match(manifest, /android:name="\.RrboxApplication"/u);
  assert.match(manifest, /android:allowBackup="false"/u);
  assert.match(manifest, /android:fullBackupContent="false"/u);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/u);
  const rules = await readAndroid("app/src/main/res/xml/data_extraction_rules.xml");
  for (const section of ["cloud-backup", "device-transfer"]) {
    const body = rules.split(`<${section}>`)[1].split(`</${section}>`)[0];
    for (const domain of ["root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"]) {
      assert.ok(body.includes(`<exclude domain="${domain}" path="." />`));
    }
  }
  assert.match(manifest, /android\.permission\.INTERNET/u);
  assert.match(manifest, /android:usesCleartextTraffic="\$\{usesCleartextTraffic\}"/u);
  assert.match(appBuild, /manifestPlaceholders\["usesCleartextTraffic"\] = "false"/u);
});

test("Android initializes native HTTPS with the application before launching Tauri", () => {
  assert.match(application, /class RrboxApplication : Application\(\)/u);
  assert.match(application, /System\.loadLibrary\("researchbox_native"\)\s+initializeTls\(\)/u);
  assert.match(application, /private external fun initializeTls\(\)/u);
  assert.match(nativeTls, /Java_dev_tokn_1ai_rrbox_RrboxApplication_initializeTls/u);
  assert.match(nativeTls, /init_with_env\(env, application\)/u);
  assert.match(nativeTls, /ThrowRuntimeExAndDefault/u);
  assert.match(appBuild, /"cargo", "metadata", "--locked"/u);
  assert.match(appBuild, /rustls-platform-verifier-android/u);
  assert.match(appBuild, /exclusiveContent/u);
  assert.doesNotMatch(appBuild, /latest\.release/u);
  assert.match(proguard, /org\.rustls\.platformverifier/u);
  assert.match(proguard, /dev\.tokn_ai\.rrbox\.RrboxApplication/u);
});

test("Android keeps the shared viewport clear of bars, cutouts, and the keyboard", () => {
  assert.match(activity, /enableEdgeToEdge\(\)/u);
  assert.match(activity, /Type\.systemBars\(\)/u);
  assert.match(activity, /Type\.displayCutout\(\)/u);
  assert.match(activity, /Type\.ime\(\)/u);
  assert.match(activity, /WindowInsetsCompat\.CONSUMED/u);
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/u);
});
