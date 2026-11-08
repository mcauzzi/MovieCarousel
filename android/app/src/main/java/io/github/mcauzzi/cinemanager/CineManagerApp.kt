package io.github.mcauzzi.cinemanager

import android.app.Application
import io.github.mcauzzi.cinemanager.crash.CrashReporting
import io.github.mcauzzi.cinemanager.security.DeviceKeyStore

class CineManagerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Per primo: cattura anche un crash durante l'inizializzazione del resto.
        CrashReporting.install(this)
        DeviceKeyStore.init(this)
    }
}
