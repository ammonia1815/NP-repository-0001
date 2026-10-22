package com.npcompanion.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

// Stores the server address and bearer token - both are sensitive (the
// token is a full credential for personal chat/health data), so this uses
// EncryptedSharedPreferences rather than plain SharedPreferences.
class Prefs(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "np_companion_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_BASE_URL, value).apply()

    var token: String
        get() = prefs.getString(KEY_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    fun hasCredentials(): Boolean = baseUrl.isNotBlank() && token.isNotBlank()

    companion object {
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_TOKEN = "token"
    }
}
