plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.xehuri.kinship"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.xehuri.kinship"
        minSdk = 26
        targetSdk = 36
        versionCode = 11
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // sherpa-onnx 的 AAR 自带 4 个 ABI 的原生库，不收窄会让 APK 体积暴涨。
        // 现代手机（含本项目目标机型）均为 arm64-v8a。
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        compose = true
        viewBinding = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
        jniLibs {
            // 端侧 KWS 只经 JNI（libsherpa-onnx-jni.so）调用。已用 ELF DT_NEEDED 核实
            // jni.so 仅依赖 libonnxruntime.so，故 C / C++ API 库无需随包分发（省约 4.9MB）。
            excludes += listOf(
                "**/libsherpa-onnx-c-api.so",
                "**/libsherpa-onnx-cxx-api.so",
            )
        }
    }

    // Test options for JUnit 5
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    // Core
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity.compose)

    // Compose BOM
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    debugImplementation(libs.compose.ui.tooling)

    // Lifecycle
    implementation(libs.lifecycle.runtime.ktx)
    implementation(libs.lifecycle.viewmodel.compose)

    // Logging (Timber)
    implementation(libs.timber)

    // Navigation
    implementation(libs.navigation.compose)

    // Google Play Services - Location
    implementation("com.google.android.gms:play-services-location:21.3.0")

    // Shizuku - 免 Root Shell 执行
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")

    implementation(libs.okhttp)

    // Glance 桌面组件（widget demo 第一波：两个纯展示形态组件 + prefs 数据桥）。
    // work-runtime-ktx 本波仅就位，周期轮询兜底通道留给第二波启用。
    implementation(libs.glance)
    implementation(libs.glance.appwidget)
    implementation(libs.work.runtime.ktx)

    // Security - EncryptedSharedPreferences
    implementation(libs.security.crypto)

    // 端侧 KWS（唤醒词本地识别）——Android AAR，内含 arm64-v8a 原生库
    implementation(libs.sherpa.onnx)

    // WebRTC DataChannel（Phase 2）：公共 STUN，无 TURN；仅音频/感知旁路
    implementation(libs.stream.webrtc.android)

    // FLAC 纯 Java 兜底编码器（MediaCodec 无 audio/flac encoder 时回退）。
    // 坐标在 Maven Central（勿用 JitPack：axet/java-flac-encoder 仓库不存在）。
    // LGPL-2.1，源码 https://github.com/amplexus/java-flac-encoder；只用
    // net.sourceforge.javaflacencoder 的 FLACEncoder/StreamConfiguration/
    // FLACFileOutputStream（纯 java.io，可在 Android 运行），勿引 javax.sound 类。
    implementation("com.github.axet:java-flac-encoder:0.3.8")

    // Testing - JUnit 5
    testImplementation(libs.junit.jupiter.api)
    testRuntimeOnly(libs.junit.jupiter.engine)
    testImplementation(libs.timber)
    testImplementation(libs.mockk)
    testImplementation(libs.truth)
    testImplementation(libs.robolectric)

    // OkHttp MockWebServer for testing
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    // Coroutines Test for StateFlow testing
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")

    // Compose UI Testing
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)

    // Android Instrumentation Testing
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.truth)
}
