plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.npcompanion.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.npcompanion.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
    // Provides the XML "Theme.Material3.*" parent referenced by
    // res/values/themes.xml - the manifest still needs an XML theme even
    // though the actual UI is built entirely in Compose.
    implementation("com.google.android.material:material:1.12.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    // MasterKey.Builder (used by Prefs.kt) was introduced after 1.0.0 - that
    // version only has the older, deprecated MasterKeys utility class.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Avatar video playback (AvatarPlayer.kt/AvatarView.kt) - chosen over
    // VideoView/MediaPlayer for reliable STATE_ENDED completion callbacks
    // when chaining many short clips back-to-back.
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    // GL video effects (ChromaKeyEffect.kt) - runs a custom fragment shader
    // on the already hardware-decoded frame to key out the known solid
    // backdrop color at render time, without needing a real alpha-channel
    // codec/decoder.
    implementation("androidx.media3:media3-effect:1.4.1")

    // Settings gear icon (ChatScreen.kt) - not covered by material3 alone.
    implementation("androidx.compose.material:material-icons-core")
    // Photo icon for the photo-attach button (ChatScreen.kt) - not in the
    // core icon set, only the extended one.
    implementation("androidx.compose.material:material-icons-extended")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
