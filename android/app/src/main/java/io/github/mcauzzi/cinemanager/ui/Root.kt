package io.github.mcauzzi.cinemanager.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.security.BiometricGate

/** Testo di [UiText] nella lingua dell'app. */
@Composable
fun UiText.resolve(): String = when (this) {
    is UiText.Raw -> text
    is UiText.Res -> stringResource(id, *args.toTypedArray())
    is UiText.Plural -> pluralStringResource(id, count, count)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CineManagerRoot(vm: MainViewModel, activity: FragmentActivity) {
    val state by vm.state.collectAsStateWithLifecycle()
    val unpairOffline by vm.unpairOffline.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }

    // Prompt biometrico a ogni richiesta del ViewModel (apertura o chiave da sbloccare).
    LaunchedEffect(state.authPending) {
        if (state.authPending) vm.onAuthResult(BiometricGate.authenticate(activity))
    }
    val message = state.message
    val messageText = message?.resolve()
    LaunchedEffect(message) {
        if (messageText != null) {
            snackbar.showSnackbar(messageText)
            vm.messageShown()
        }
    }
    BackHandler(enabled = canGoBack(state)) { vm.back() }

    val settings = state.settings
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (settings != null) R.string.settings_title else titleFor(state.screen))) },
                navigationIcon = {
                    if (canGoBack(state)) {
                        IconButton(onClick = { vm.back() }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                        }
                    }
                },
                actions = {
                    if (settings == null && !state.locked && state.screen is Screen.Scan) {
                        IconButton(onClick = vm::openSettings) {
                            Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings_title))
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar, Modifier.semantics { liveRegion = LiveRegionMode.Polite }) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (state.busy) {
                val busyLabel = stringResource(R.string.busy)
                LinearProgressIndicator(Modifier.fillMaxWidth().semantics { contentDescription = busyLabel })
            }
            Box(Modifier.fillMaxSize()) {
                when {
                    state.locked -> LockedScreen(onUnlock = vm::requestUnlock)
                    settings != null -> SettingsScreen(settings, state.busy, vm)
                    else -> ScreenContent(state, vm)
                }
            }
        }
    }

    if (unpairOffline) {
        AlertDialog(
            onDismissRequest = vm::dismissUnpairOffline,
            title = { Text(stringResource(R.string.settings_unpair_offline_title)) },
            text = { Text(stringResource(R.string.settings_unpair_offline_body)) },
            confirmButton = { TextButton(onClick = { vm.dismissUnpairOffline(); vm.unpair(force = true) }) { Text(stringResource(R.string.settings_unpair_anyway)) } },
            dismissButton = { TextButton(onClick = vm::dismissUnpairOffline) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

private fun canGoBack(state: UiState): Boolean = !state.locked && (
    state.settings != null || when (val s = state.screen) {
        is Screen.Pairing -> s.scanning
        is Screen.Choose, is Screen.Form, is Screen.Result -> true
        else -> false
    }
    )

private fun titleFor(screen: Screen): Int = when (screen) {
    Screen.Loading -> R.string.app_title
    is Screen.Pairing, is Screen.Repair -> R.string.pair_title
    is Screen.UpdateRequired -> R.string.update_required_title
    is Screen.OwnerInactive -> R.string.owner_inactive_title
    is Screen.Scan -> R.string.scan_title
    is Screen.Choose -> R.string.choose_title
    is Screen.Form -> R.string.form_title
    is Screen.Result -> R.string.result_title
}

@Composable
private fun ScreenContent(state: UiState, vm: MainViewModel) {
    when (val s = state.screen) {
        Screen.Loading -> Unit
        is Screen.Pairing -> PairingScreen(s, state.busy, vm)
        is Screen.Repair -> RepairScreen(s, onRepair = vm::startPairing)
        is Screen.UpdateRequired -> UpdateRequiredScreen(s)
        is Screen.OwnerInactive -> OwnerInactiveScreen(s, onRetry = vm::retryAfterOwnerInactive)
        is Screen.Scan -> ScanScreen(s, state.busy, state.update, vm)
        is Screen.Choose -> ChooseScreen(s, state.busy, vm)
        is Screen.Form -> FormScreen(s, state.busy, vm)
        is Screen.Result -> ResultScreen(s, state.busy, vm)
    }
}
