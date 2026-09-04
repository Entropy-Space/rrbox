import java.util.Properties
import groovy.json.JsonSlurper

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("rust")
}

val tauriProperties = Properties().apply {
  val propFile = file("tauri.properties")
  if (propFile.exists()) {
    propFile.inputStream().use { load(it) }
  }
}

val keepRustDebugSymbols = providers.gradleProperty("keepRustDebugSymbols")
  .map(String::toBoolean).getOrElse(false)

// Resolve the Kotlin verifier from the same locked Cargo package as Rust.
// It is bundled in the crate rather than published on Maven Central.
val cargoMetadata = providers.exec {
  workingDir(file("../../.."))
  commandLine("cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", "aarch64-linux-android")
}.standardOutput.asText.get()
val cargoPackages = (JsonSlurper().parseText(cargoMetadata) as Map<*, *>)["packages"] as List<*>
val verifierPackage = cargoPackages.filterIsInstance<Map<*, *>>().single {
  it["name"] == "rustls-platform-verifier-android"
}
val verifierMavenDir = file(verifierPackage["manifest_path"] as String).parentFile.resolve("maven")

repositories {
  exclusiveContent {
    forRepository {
      maven {
        name = "rustlsPlatformVerifier"
        url = uri(verifierMavenDir)
      }
    }
    filter { includeGroup("rustls") }
  }
}

android {
  compileSdk = 37
  buildToolsVersion = "37.0.0"
  ndkVersion = "29.0.14206865"
  namespace = "dev.tokn_ai.rrbox"
  defaultConfig {
    manifestPlaceholders["usesCleartextTraffic"] = "false"
    applicationId = "dev.tokn_ai.rrbox"
    minSdk = 24
    targetSdk = 36
    versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
    versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
  }
  buildTypes {
    getByName("debug") {
      manifestPlaceholders["usesCleartextTraffic"] = "true"
      isDebuggable = true
      isJniDebuggable = keepRustDebugSymbols
      isMinifyEnabled = false
      if (keepRustDebugSymbols) {
        packaging.jniLibs.keepDebugSymbols.add("**/*.so")
      }
    }
    getByName("release") {
      isMinifyEnabled = true
      proguardFiles(
        *fileTree(".") { include("**/*.pro") }
          .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
          .toList().toTypedArray()
      )
    }
  }
  kotlinOptions {
    jvmTarget = "1.8"
  }
  buildFeatures {
    buildConfig = true
  }
}

rust {
  rootDirRel = "../../../"
}

dependencies {
  implementation("rustls:rustls-platform-verifier:${verifierPackage["version"]}")
  implementation("androidx.webkit:webkit:1.14.0")
  implementation("androidx.appcompat:appcompat:1.7.1")
  implementation("androidx.activity:activity-ktx:1.10.1")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.lifecycle:lifecycle-process:2.10.0")
  testImplementation("junit:junit:4.13.2")
  androidTestImplementation("androidx.test.ext:junit:1.1.4")
  androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
