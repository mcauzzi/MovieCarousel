package io.github.mcauzzi.cinemanager

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.fragment.app.FragmentActivity
import io.github.mcauzzi.cinemanager.ui.CineManagerRoot
import io.github.mcauzzi.cinemanager.ui.MainViewModel
import io.github.mcauzzi.cinemanager.ui.theme.CineManagerTheme

/** FragmentActivity: serve a BiometricPrompt. */
class MainActivity : FragmentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            CineManagerTheme {
                CineManagerRoot(vm, activity = this)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        vm.onForeground()
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) vm.onBackground()
    }
}
