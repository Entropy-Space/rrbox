import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.security.MessageDigest

plugins {
  id("com.android.library")
}

// Build adapter for tauri 2.11.5's Android sources. Keep dependencies aligned
// with mobile/android/build.gradle.kts when updating the Cargo-locked crate.
val tauriSourceDir = gradle.extra["tauriAndroidSourceDir"] as File
val upstreamBuildHash = MessageDigest.getInstance("SHA-256")
  .digest(tauriSourceDir.resolve("build.gradle.kts").readBytes())
  .joinToString("") { "%02x".format(it) }
check(upstreamBuildHash == "aab1b0ecb929ea70b33ad42d7df55c185a3485f9609ec998047232b45df76a4d") {
  "Tauri's Android build script changed; review this adapter's sources, dependencies, and ProGuard rules."
}

android {
  namespace = "app.tauri"
  compileSdk = 37
  buildToolsVersion = "37.0.0"
  defaultConfig {
    minSdk = 21
    consumerProguardFiles(tauriSourceDir.resolve("proguard-rules.pro"))
  }
  sourceSets {
    getByName("main") {
      manifest.srcFile(tauriSourceDir.resolve("src/main/AndroidManifest.xml"))
      java.setSrcDirs(listOf(tauriSourceDir.resolve("src/main/java")))
      res.setSrcDirs(listOf(tauriSourceDir.resolve("src/main/res")))
      assets.setSrcDirs(listOf(tauriSourceDir.resolve("src/main/assets")))
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
  }
  buildFeatures {
    buildConfig = true
  }
}

kotlin {
  compilerOptions {
    jvmTarget = JvmTarget.JVM_1_8
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.7.0")
  implementation("androidx.appcompat:appcompat:1.6.0")
  implementation("com.google.android.material:material:1.7.0")
  implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
}
