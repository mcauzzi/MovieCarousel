package io.github.mcauzzi.cinemanager.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.core.api.AppVersionInfo
import io.github.mcauzzi.cinemanager.core.api.Candidate
import io.github.mcauzzi.cinemanager.core.api.DuplicateRef

// ---------------------------------------------------------------------------- comuni

@Composable
fun Heading(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.titleLarge, modifier = modifier.semantics { heading() })
}

@Composable
private fun Page(content: @Composable ColumnScope.() -> Unit) {
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
private fun duplicateLabel(d: DuplicateRef): String {
    val title = d.title ?: stringResource(R.string.untitled)
    return if (d.year != null) "$title (${d.year})" else title
}

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
    var showManual by remember { mutableStateOf(false) }
    Page {
        Heading(stringResource(R.string.pair_heading))
        Text(stringResource(R.string.pair_intro))
        OutlinedTextField(
            value = s.deviceName,
            onValueChange = vm::onDeviceNameChange,
            label = { Text(stringResource(R.string.pair_device_name)) },
            supportingText = { Text(stringResource(R.string.pair_device_name_help)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        s.error?.let { ErrorText(it.resolve()) }
        Button(onClick = { vm.setPairScanning(true) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(stringResource(R.string.pair_scan))
        }
        TextButton(onClick = { showManual = !showManual }, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.pair_manual_toggle))
        }
        if (showManual) {
            OutlinedTextField(
                value = s.manual,
                onValueChange = vm::onPairManualChange,
                label = { Text(stringResource(R.string.pair_manual_label)) },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(onClick = { vm.onPairingQr(s.manual) }, enabled = !busy && s.manual.isNotBlank(), modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.pair_manual_submit))
            }
        }
    }
}

@Composable
fun ErrorText(text: String) {
    Text(text, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
}

@Composable
fun RepairScreen(s: Screen.Repair, onRepair: () -> Unit) = Centered {
    Heading(stringResource(R.string.repair_title))
    Text(s.reason.resolve(), textAlign = TextAlign.Center)
    Button(onClick = onRepair, Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.repair_action)) }
}

@Composable
fun LockedScreen(onUnlock: () -> Unit) = Centered {
    Heading(stringResource(R.string.locked_title))
    Text(stringResource(R.string.locked_body), textAlign = TextAlign.Center)
    Button(onClick = onUnlock, Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.locked_action)) }
}

@Composable
fun UpdateRequiredScreen(s: Screen.UpdateRequired) = Centered {
    val uri = LocalUriHandler.current
    Heading(stringResource(R.string.update_required_title))
    Text(stringResource(R.string.update_required_body), textAlign = TextAlign.Center)
    s.apkUrl?.let { url ->
        Button(onClick = { uri.openUri(url) }, Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.update_download)) }
        Text(stringResource(R.string.update_install_note), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
    }
}

@Composable
fun OwnerInactiveScreen(s: Screen.OwnerInactive, onRetry: () -> Unit) = Centered {
    val uri = LocalUriHandler.current
    Heading(stringResource(R.string.owner_inactive_title))
    Text(stringResource(R.string.owner_inactive_body), textAlign = TextAlign.Center)
    s.siteUrl?.let { url ->
        Button(onClick = { uri.openUri(url) }, Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.owner_inactive_open_site)) }
    }
    OutlinedButton(onClick = onRetry, Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.action_retry)) }
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
                    TextButton(onClick = { vm.apkUrl()?.let(uri::openUri) }, Modifier.heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.update_download))
                    }
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
            Button(onClick = vm::submitManualEan, enabled = !busy && s.manualEan.length >= 8, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.scan_manual_submit))
            }
        }
    }
}

// ---------------------------------------------------------------------------- scelta

@Composable
fun ChooseScreen(s: Screen.Choose, busy: Boolean, vm: MainViewModel) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.choose_ean, s.ean), style = MaterialTheme.typography.bodyMedium)
                s.lookup.productName?.let { Text(stringResource(R.string.choose_product, it), style = MaterialTheme.typography.bodyMedium) }
            }
        }
        item { DuplicatesWarning(s.lookup.possibleDuplicates) }
        if (s.candidates.isNotEmpty()) {
            item { Heading(stringResource(R.string.choose_pick)) }
            items(s.candidates, key = { it.tmdbId }) { c -> CandidateRow(c, enabled = !busy) { vm.choose(c) } }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                HorizontalDivider()
                Heading(stringResource(R.string.choose_search_heading))
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
                    Button(onClick = vm::search, enabled = !busy && s.query.isNotBlank(), modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.choose_search))
                    }
                    OutlinedButton(onClick = vm::fillManually, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.choose_manual))
                    }
                }
            }
        }
    }
}

@Composable
private fun CandidateRow(c: Candidate, enabled: Boolean, onClick: () -> Unit) {
    val label = if (c.year != null) "${c.title} (${c.year})" else c.title
    Card(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
        ListItem(
            headlineContent = { Text(label) },
            supportingContent = c.originalTitle?.takeIf { it != c.title }?.let { { Text(it) } },
            leadingContent = {
                Poster(c.posterUrl, stringResource(R.string.poster_of, c.title), Modifier.width(56.dp))
            },
        )
    }
}

@Composable
fun Poster(url: String?, description: String, modifier: Modifier = Modifier) {
    if (url == null) {
        Spacer(modifier.aspectRatio(2f / 3f))
        return
    }
    AsyncImage(model = url, contentDescription = description, contentScale = ContentScale.Crop, modifier = modifier.aspectRatio(2f / 3f))
}

// ---------------------------------------------------------------------------- esito

@Composable
fun ResultScreen(s: Screen.Result, busy: Boolean, vm: MainViewModel) = Centered {
    when (val o = s.outcome) {
        is Outcome.Added -> {
            Heading(stringResource(R.string.result_added_title))
            Text(stringResource(R.string.result_added_body, o.title), textAlign = TextAlign.Center)
        }
        is Outcome.EanExists -> {
            Heading(stringResource(R.string.result_exists_title))
            Text(
                o.title?.let { stringResource(R.string.result_exists_body, it) } ?: stringResource(R.string.result_exists_body_untitled),
                textAlign = TextAlign.Center,
            )
        }
        is Outcome.PossibleDuplicate -> {
            Heading(stringResource(R.string.result_duplicate_title))
            Text(stringResource(R.string.result_duplicate_body), textAlign = TextAlign.Center)
            DuplicatesWarning(o.candidates)
            Button(onClick = vm::confirmDuplicate, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.result_duplicate_confirm))
            }
            OutlinedButton(onClick = vm::backToForm, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.result_duplicate_edit))
            }
        }
    }
    Button(onClick = vm::scanNext, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.result_next)) }
}

// ---------------------------------------------------------------------------- impostazioni

@Composable
fun SettingsScreen(s: SettingsInfo, busy: Boolean, vm: MainViewModel) {
    var confirmBiometric by remember { mutableStateOf<Boolean?>(null) }
    var confirmUnpair by remember { mutableStateOf(false) }
    val uri = LocalUriHandler.current
    Page {
        Heading(stringResource(R.string.settings_pairing))
        InfoRow(stringResource(R.string.settings_server), s.server)
        InfoRow(stringResource(R.string.settings_user), s.userName)
        InfoRow(stringResource(R.string.settings_device), s.deviceName)
        TextButton(onClick = { uri.openUri(s.siteUrl) }, Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.settings_open_site)) }
        HorizontalDivider()

        Heading(stringResource(R.string.settings_security))
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).toggleable(
                value = s.requireBiometric,
                enabled = !busy && (s.biometricAvailable || s.requireBiometric),
                role = Role.Switch,
                onValueChange = { confirmBiometric = it },
            ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.settings_biometric))
                Text(
                    stringResource(if (s.biometricAvailable) R.string.settings_biometric_help else R.string.settings_biometric_unavailable),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Switch(checked = s.requireBiometric, onCheckedChange = null, enabled = !busy && (s.biometricAvailable || s.requireBiometric))
        }
        OutlinedButton(onClick = { confirmUnpair = true }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.settings_unpair))
        }
        HorizontalDivider()

        Heading(stringResource(R.string.settings_about))
        InfoRow(stringResource(R.string.settings_version), s.appVersion)
        Text(stringResource(R.string.tmdb_attribution), style = MaterialTheme.typography.bodySmall)
    }

    confirmBiometric?.let { value ->
        AlertDialog(
            onDismissRequest = { confirmBiometric = null },
            title = { Text(stringResource(if (value) R.string.settings_biometric_on_title else R.string.settings_biometric_off_title)) },
            text = { Text(stringResource(R.string.settings_biometric_repair)) },
            confirmButton = { TextButton(onClick = { confirmBiometric = null; vm.setRequireBiometric(value) }) { Text(stringResource(R.string.action_continue)) } },
            dismissButton = { TextButton(onClick = { confirmBiometric = null }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text(stringResource(R.string.settings_unpair_title)) },
            text = { Text(stringResource(R.string.settings_unpair_body)) },
            confirmButton = { TextButton(onClick = { confirmUnpair = false; vm.unpair(force = false) }) { Text(stringResource(R.string.settings_unpair)) } },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text(stringResource(R.string.action_cancel)) } },
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

