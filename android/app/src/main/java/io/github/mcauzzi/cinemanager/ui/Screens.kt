package io.github.mcauzzi.cinemanager.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.core.api.AppVersionInfo
import io.github.mcauzzi.cinemanager.core.api.Candidate
import io.github.mcauzzi.cinemanager.core.api.DuplicateRef

// ---------------------------------------------------------------------------- comuni

@Composable
fun Heading(@StringRes id: Int) = Text(stringResource(id), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })

enum class ButtonKind { FILLED, OUTLINED, TEXT }

/** Pulsante con etichetta da risorsa e area di tocco di almeno 48 dp. */
@Composable
fun ActionButton(
    @StringRes label: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    kind: ButtonKind = ButtonKind.FILLED,
) {
    val m = modifier.heightIn(min = 48.dp)
    val content: @Composable RowScope.() -> Unit = { Text(stringResource(label)) }
    when (kind) {
        ButtonKind.FILLED -> Button(onClick = onClick, modifier = m, enabled = enabled, content = content)
        ButtonKind.OUTLINED -> OutlinedButton(onClick = onClick, modifier = m, enabled = enabled, content = content)
        ButtonKind.TEXT -> TextButton(onClick = onClick, modifier = m, enabled = enabled, content = content)
    }
}

/** Dialog di conferma con "Annulla"; [onConfirm] dopo la chiusura. */
@Composable
fun ConfirmDialog(title: String, body: String, @StringRes confirm: Int, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = { TextButton(onClick = { onDismiss(); onConfirm() }) { Text(stringResource(confirm)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
fun Page(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
private fun Centered(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
        content = content,
    )
}

@Composable
fun DuplicatesWarning(list: List<DuplicateRef>) {
    if (list.isEmpty()) return
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.duplicates_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            list.forEach { d -> Text("• " + duplicateLabel(d)) }
        }
    }
}

@Composable
private fun duplicateLabel(d: DuplicateRef) = titleYear(d.title ?: stringResource(R.string.untitled), d.year)

private fun titleYear(title: String, year: Int?) = if (year != null) "$title ($year)" else title

// ---------------------------------------------------------------------------- abbinamento

@Composable
fun PairingScreen(s: Screen.Pairing, busy: Boolean, vm: MainViewModel) {
    if (s.scanning) {
        Column(Modifier.fillMaxSize()) {
            Text(stringResource(R.string.pair_scan_hint), Modifier.padding(16.dp))
            CameraScanner(ScanMode.QR, enabled = !busy, onDetected = vm::onPairingQr, modifier = Modifier.fillMaxWidth().weight(1f))
            TextButton(onClick = { vm.setPairScanning(false) }, Modifier.padding(8.dp).align(Alignment.CenterHorizontally)) {
                Text(stringResource(R.string.action_cancel))
            }
        }
        return
    }
    var showManual by rememberSaveable { mutableStateOf(false) }
    Page {
        Heading(R.string.pair_heading)
        Text(stringResource(R.string.pair_intro))
        OutlinedTextField(
            value = s.deviceName,
            onValueChange = vm::onDeviceNameChange,
            label = { Text(stringResource(R.string.pair_device_name)) },
            supportingText = { Text(stringResource(R.string.pair_device_name_help)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        BiometricToggle(
            checked = s.requireBiometric,
            available = s.biometricAvailable,
            enabled = !busy,
            onChange = vm::setPairRequireBiometric,
        )
        s.error?.let { ErrorText(it.resolve()) }
        ActionButton(R.string.pair_scan, { vm.setPairScanning(true) }, Modifier.fillMaxWidth(), enabled = !busy)
        ActionButton(R.string.pair_manual_toggle, { showManual = !showManual }, kind = ButtonKind.TEXT)
        if (showManual) {
            OutlinedTextField(
                value = s.manual,
                onValueChange = vm::onPairManualChange,
                label = { Text(stringResource(R.string.pair_manual_label)) },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            ActionButton(
                R.string.pair_manual_submit, { vm.onPairingQr(s.manual) },
                enabled = !busy && s.manual.isNotBlank(), kind = ButtonKind.OUTLINED,
            )
        }
    }
}

/** Testo d'errore annunciato da TalkBack quando compare o cambia. */
@Composable
fun ErrorText(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/**
 * Interruttore "Chiedi impronta all'apertura". Attivabile solo con un blocco schermo sicuro;
 * se è già attivo si può sempre spegnere (es. dopo aver tolto il blocco schermo).
 */
@Composable
private fun BiometricToggle(checked: Boolean, available: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    SwitchRow(checked, enabled = enabled && (available || checked), onChange, minHeight = 56.dp) {
        Text(stringResource(R.string.settings_biometric))
        Text(
            stringResource(if (available) R.string.settings_biometric_help else R.string.settings_biometric_unavailable),
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

/** Riga intera che fa da interruttore (un solo elemento per TalkBack, ruolo Switch). */
@Composable
fun SwitchRow(checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit, minHeight: Dp, label: @Composable ColumnScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = minHeight)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), content = label)
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

@Composable
fun RepairScreen(s: Screen.Repair, onRepair: () -> Unit) = Centered {
    Heading(R.string.repair_title)
    Text(s.reason.resolve(), textAlign = TextAlign.Center)
    if (s.serverStillActive) Text(stringResource(R.string.repair_server_active), textAlign = TextAlign.Center)
    ActionButton(R.string.repair_action, onRepair)
}

@Composable
fun LockedScreen(onUnlock: () -> Unit) = Centered {
    Heading(R.string.locked_title)
    Text(stringResource(R.string.locked_body), textAlign = TextAlign.Center)
    ActionButton(R.string.locked_action, onUnlock)
}

@Composable
fun UpdateRequiredScreen(s: Screen.UpdateRequired) = Centered {
    val uri = LocalUriHandler.current
    Heading(R.string.update_required_title)
    Text(stringResource(R.string.update_required_body), textAlign = TextAlign.Center)
    s.apkUrl?.let { url ->
        ActionButton(R.string.update_download, { uri.openUri(url) })
        Text(stringResource(R.string.update_install_note), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
    }
}

@Composable
fun OwnerInactiveScreen(s: Screen.OwnerInactive, onRetry: () -> Unit) = Centered {
    val uri = LocalUriHandler.current
    Heading(R.string.owner_inactive_title)
    Text(stringResource(R.string.owner_inactive_body), textAlign = TextAlign.Center)
    s.siteUrl?.let { url ->
        ActionButton(R.string.owner_inactive_open_site, { uri.openUri(url) })
    }
    ActionButton(R.string.action_retry, onRetry, kind = ButtonKind.OUTLINED)
}

// ---------------------------------------------------------------------------- scansione

@Composable
fun ScanScreen(s: Screen.Scan, busy: Boolean, update: AppVersionInfo?, vm: MainViewModel) {
    val uri = LocalUriHandler.current
    Column(Modifier.fillMaxSize()) {
        if (update != null) {
            Card(Modifier.fillMaxWidth().padding(8.dp)) {
                Row(Modifier.padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.update_available, update.version), Modifier.weight(1f))
                    ActionButton(R.string.update_download, { vm.apkUrl()?.let(uri::openUri) }, kind = ButtonKind.TEXT)
                }
            }
        }
        Text(stringResource(R.string.scan_hint), Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        CameraScanner(ScanMode.EAN, enabled = !busy, onDetected = vm::onBarcode, modifier = Modifier.fillMaxWidth().weight(1f))
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = s.manualEan,
                onValueChange = vm::onManualEanChange,
                label = { Text(stringResource(R.string.scan_manual_label)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { vm.submitManualEan() }),
                modifier = Modifier.weight(1f),
            )
            ActionButton(R.string.scan_manual_submit, vm::submitManualEan, enabled = !busy && s.manualEan.length >= 8)
        }
    }
}

// ---------------------------------------------------------------------------- scelta

@Composable
fun ChooseScreen(s: Screen.Choose, busy: Boolean, vm: MainViewModel) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.choose_ean, s.ean), style = MaterialTheme.typography.bodyMedium)
                s.lookup.productName?.let { Text(stringResource(R.string.choose_product, it), style = MaterialTheme.typography.bodyMedium) }
            }
        }
        item { DuplicatesWarning(s.lookup.possibleDuplicates) }
        if (s.candidates.isNotEmpty()) {
            item { Heading(R.string.choose_pick) }
            items(s.candidates, key = { it.tmdbId }) { c -> CandidateRow(c, enabled = !busy) { vm.choose(c) } }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                HorizontalDivider()
                Heading(R.string.choose_search_heading)
                OutlinedTextField(
                    value = s.query, onValueChange = vm::onQueryChange,
                    label = { Text(stringResource(R.string.choose_query)) }, singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { vm.search() }),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = s.year, onValueChange = vm::onYearChange,
                    label = { Text(stringResource(R.string.choose_year)) }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { vm.search() }),
                    modifier = Modifier.width(160.dp),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionButton(R.string.choose_search, vm::search, enabled = !busy && s.query.isNotBlank())
                    ActionButton(R.string.choose_manual, vm::fillManually, enabled = !busy, kind = ButtonKind.OUTLINED)
                }
            }
        }
    }
}

@Composable
private fun CandidateRow(c: Candidate, enabled: Boolean, onClick: () -> Unit) {
    Card(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
        ListItem(
            headlineContent = { Text(titleYear(c.title, c.year)) },
            supportingContent = c.originalTitle?.takeIf { it != c.title }?.let { { Text(it) } },
            leadingContent = {
                Poster(c.posterUrl, stringResource(R.string.poster_of, c.title), Modifier.width(56.dp))
            },
        )
    }
}

@Composable
fun Poster(url: String?, description: String, modifier: Modifier = Modifier) {
    val m = modifier.aspectRatio(2f / 3f)
    if (url == null) Spacer(m) else AsyncImage(model = url, contentDescription = description, contentScale = ContentScale.Crop, modifier = m)
}

// ---------------------------------------------------------------------------- esito

@Composable
fun ResultScreen(s: Screen.Result, busy: Boolean, vm: MainViewModel) = Centered {
    when (val o = s.outcome) {
        is Outcome.Added -> {
            Heading(R.string.result_added_title)
            Text(stringResource(R.string.result_added_body, o.title), textAlign = TextAlign.Center)
        }
        is Outcome.EanExists -> {
            Heading(R.string.result_exists_title)
            Text(
                o.title?.let { stringResource(R.string.result_exists_body, it) } ?: stringResource(R.string.result_exists_body_untitled),
                textAlign = TextAlign.Center,
            )
        }
        is Outcome.PossibleDuplicate -> {
            Heading(R.string.result_duplicate_title)
            Text(stringResource(R.string.result_duplicate_body), textAlign = TextAlign.Center)
            DuplicatesWarning(o.candidates)
            ActionButton(R.string.result_duplicate_confirm, vm::confirmDuplicate, enabled = !busy)
            ActionButton(R.string.result_duplicate_edit, vm::backToForm, enabled = !busy, kind = ButtonKind.OUTLINED)
        }
    }
    ActionButton(R.string.result_next, vm::scanNext, enabled = !busy)
}

// ---------------------------------------------------------------------------- impostazioni

@Composable
fun SettingsScreen(s: SettingsInfo, busy: Boolean, vm: MainViewModel) {
    var confirmBiometric by rememberSaveable { mutableStateOf<Boolean?>(null) }
    var confirmUnpair by rememberSaveable { mutableStateOf(false) }
    val uri = LocalUriHandler.current
    Page {
        Heading(R.string.settings_pairing)
        InfoRow(stringResource(R.string.settings_server), s.server)
        InfoRow(stringResource(R.string.settings_user), s.userName)
        InfoRow(stringResource(R.string.settings_device), s.deviceName)
        ActionButton(R.string.settings_open_site, { uri.openUri(s.siteUrl) }, kind = ButtonKind.TEXT)
        HorizontalDivider()

        Heading(R.string.settings_security)
        BiometricToggle(
            checked = s.requireBiometric,
            available = s.biometricAvailable,
            enabled = !busy,
            onChange = { confirmBiometric = it },
        )
        ActionButton(R.string.settings_unpair, { confirmUnpair = true }, enabled = !busy, kind = ButtonKind.OUTLINED)
        HorizontalDivider()

        Heading(R.string.settings_about)
        InfoRow(stringResource(R.string.settings_version), s.appVersion)
        Text(stringResource(R.string.tmdb_attribution), style = MaterialTheme.typography.bodySmall)
    }

    confirmBiometric?.let { value ->
        ConfirmDialog(
            stringResource(if (value) R.string.settings_biometric_on_title else R.string.settings_biometric_off_title),
            stringResource(R.string.settings_biometric_repair), R.string.action_continue,
            onConfirm = { vm.setRequireBiometric(value) }, onDismiss = { confirmBiometric = null },
        )
    }
    if (confirmUnpair) {
        ConfirmDialog(
            stringResource(R.string.settings_unpair_title), stringResource(R.string.settings_unpair_body), R.string.settings_unpair,
            onConfirm = { vm.unpair(force = false) }, onDismiss = { confirmUnpair = false },
        )
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Column(Modifier.semantics(mergeDescendants = true) {}) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        Text(value.ifEmpty { "—" }, style = MaterialTheme.typography.bodyLarge)
    }
}

