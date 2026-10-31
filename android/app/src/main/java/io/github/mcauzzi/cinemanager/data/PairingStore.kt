package io.github.mcauzzi.cinemanager.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.dataStore by preferencesDataStore(name = "cinemanager")

/** Abbinamento salvato: nessun segreto (la chiave privata sta solo nel Keystore). */
data class Pairing(val apiBase: String, val deviceId: String, val deviceName: String, val userName: String)

data class Settings(val pairing: Pairing?, val requireBiometric: Boolean)

class PairingStore(private val context: Context) {
    private object Keys {
        val API = stringPreferencesKey("api_base")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val DEVICE_NAME = stringPreferencesKey("device_name")
        val USER_NAME = stringPreferencesKey("user_name")
        val BIOMETRIC = booleanPreferencesKey("require_biometric")
        val PAIRING = listOf(API, DEVICE_ID, DEVICE_NAME, USER_NAME)
    }

    suspend fun load(): Settings = context.dataStore.data.first().toSettings()

    suspend fun savePairing(p: Pairing) {
        context.dataStore.edit {
            it[Keys.API] = p.apiBase
            it[Keys.DEVICE_ID] = p.deviceId
            it[Keys.DEVICE_NAME] = p.deviceName
            it[Keys.USER_NAME] = p.userName
        }
    }

    suspend fun clearPairing() {
        context.dataStore.edit { prefs -> Keys.PAIRING.forEach { prefs.remove(it) } }
    }

    suspend fun setRequireBiometric(value: Boolean) {
        context.dataStore.edit { it[Keys.BIOMETRIC] = value }
    }

    private fun Preferences.toSettings(): Settings {
        val api = this[Keys.API]
        val id = this[Keys.DEVICE_ID]
        val pairing = if (api != null && id != null) {
            Pairing(api, id, this[Keys.DEVICE_NAME].orEmpty(), this[Keys.USER_NAME].orEmpty())
        } else {
            null
        }
        return Settings(pairing, this[Keys.BIOMETRIC] ?: false)
    }
}
