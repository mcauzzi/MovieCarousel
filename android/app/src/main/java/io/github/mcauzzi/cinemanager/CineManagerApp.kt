package io.github.mcauzzi.cinemanager

import android.app.Application
import io.github.mcauzzi.cinemanager.security.DeviceKeyStore

class CineManagerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        DeviceKeyStore.init(this)
    }
}
