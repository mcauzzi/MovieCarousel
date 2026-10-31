package io.github.mcauzzi.cinemanager.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.core.form.FieldType
import io.github.mcauzzi.cinemanager.core.form.FieldValue
import io.github.mcauzzi.cinemanager.core.form.FormField

/** 4. Modulo: un controllo per tipo di campo, dati della bozza modificabili, poi INVIA. */
@Composable
fun FormScreen(s: Screen.Form, busy: Boolean, vm: MainViewModel) {
    val title = (s.values["title"] as? FieldValue.Text)?.value.orEmpty()
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (s.source.posterUrl != null) {
                Poster(s.source.posterUrl, stringResource(R.string.poster_of, title), Modifier.width(96.dp))
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.choose_ean, s.source.ean), style = MaterialTheme.typography.bodyMedium)
                if (s.source.tmdbId == null) Text(stringResource(R.string.form_no_tmdb), style = MaterialTheme.typography.bodySmall)
                s.source.choose?.let {
                    TextButton(onClick = { vm.back() }, Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.form_wrong_movie)) }
                }
            }
        }
        DuplicatesWarning(s.source.duplicates)
        s.generalError?.let { ErrorText(it.resolve()) }

        s.fields.forEach { f ->
            FieldEditor(f, s.values[f.def.name] ?: f.empty(), s.errors[f.def.name], enabled = !busy) { vm.onFieldChange(f.def.name, it) }
        }
        // Errori del server su proprietà fuori dal modulo (ean, posterPath...).
        s.errors.filterKeys { k -> s.fields.none { it.def.name == k } }.forEach { (k, v) -> ErrorText("$k: $v") }

        Button(onClick = { vm.submit() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(stringResource(R.string.form_submit))
        }
    }
}

@Composable
private fun FieldEditor(f: FormField, value: FieldValue, error: String?, enabled: Boolean, onChange: (FieldValue) -> Unit) {
    val label = f.def.title
    when (value) {
        is FieldValue.Flag -> Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .toggleable(value.checked, enabled = enabled, role = Role.Switch) { onChange(FieldValue.Flag(it)) },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, Modifier.weight(1f))
            Switch(checked = value.checked, onCheckedChange = null, enabled = enabled)
        }
        is FieldValue.Text -> TextEditor(f, value.value, error, enabled) { onChange(FieldValue.Text(it)) }
        is FieldValue.Multi -> MultiEditor(f, value.values, error, enabled) { onChange(FieldValue.Multi(it)) }
        is FieldValue.Rows -> RowsEditor(f, value.rows, error, enabled) { onChange(FieldValue.Rows(it)) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TextEditor(f: FormField, value: String, error: String?, enabled: Boolean, onChange: (String) -> Unit) {
    val label = f.def.title
    if (f.restricted) {
        var expanded by remember { mutableStateOf(false) }
        ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { if (enabled) expanded = it }) {
            OutlinedTextField(
                value = value, onValueChange = {}, readOnly = true, enabled = enabled,
                label = { Text(label) },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                isError = error != null, supportingText = error?.let { { Text(it) } },
                modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
            )
            ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.form_none)) }, onClick = { onChange(""); expanded = false })
                f.options.forEach { o -> DropdownMenuItem(text = { Text(o) }, onClick = { onChange(o); expanded = false }) }
            }
        }
        return
    }
    val keyboard = when (f.type) {
        FieldType.NUMBER, FieldType.RATING -> KeyboardOptions(keyboardType = KeyboardType.Number)
        FieldType.URL -> KeyboardOptions(keyboardType = KeyboardType.Uri)
        else -> KeyboardOptions.Default
    }
    Column {
        OutlinedTextField(
            value = value, onValueChange = onChange, enabled = enabled,
            label = { Text(label) },
            placeholder = if (f.type == FieldType.DATE) ({ Text(stringResource(R.string.form_date_placeholder)) }) else null,
            singleLine = f.type != FieldType.PARA,
            minLines = if (f.type == FieldType.PARA) 3 else 1,
            keyboardOptions = keyboard,
            isError = error != null, supportingText = error?.let { { Text(it) } },
            modifier = Modifier.fillMaxWidth().semantics { if (error != null) error(error) },
        )
        // Valori proposti (es. supporto DVD / Blu-ray / 4K) senza vincolo.
        if (f.options.isNotEmpty()) {
            OptionChips(f.options, selected = listOf(value), enabled = enabled) { o -> onChange(if (o == value) "" else o) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OptionChips(options: List<String>, selected: List<String>, enabled: Boolean, onToggle: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { o ->
            FilterChip(selected = selected.any { it.equals(o, ignoreCase = true) }, onClick = { onToggle(o) }, enabled = enabled, label = { Text(o) })
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MultiEditor(f: FormField, values: List<String>, error: String?, enabled: Boolean, onChange: (List<String>) -> Unit) {
    var input by rememberSaveable(f.def.name) { mutableStateOf("") }
    fun add() {
        val v = input.trim()
        if (v.isNotEmpty() && values.none { it.equals(v, ignoreCase = true) }) onChange(values + v)
        input = ""
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(f.def.title, style = MaterialTheme.typography.labelLarge)
        if (values.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                values.forEach { v ->
                    val remove = stringResource(R.string.form_remove_value, v)
                    InputChip(
                        selected = false, enabled = enabled,
                        onClick = { onChange(values - v) },
                        label = { Text(v) },
                        trailingIcon = { Icon(Icons.Filled.Close, contentDescription = null) },
                        modifier = Modifier.semantics { contentDescription = remove },
                    )
                }
            }
        }
        if (f.options.isNotEmpty()) {
            OptionChips(f.options, values, enabled) { o -> onChange(if (values.contains(o)) values - o else values + o) }
        }
        if (!f.restricted) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = input, onValueChange = { input = it }, enabled = enabled,
                    label = { Text(stringResource(R.string.form_add_value, f.def.title)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { add() }),
                    isError = error != null, supportingText = error?.let { { Text(it) } },
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(onClick = { add() }, enabled = enabled && input.isNotBlank(), modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(stringResource(R.string.form_add))
                }
            }
        } else if (error != null) {
            ErrorText(error)
        }
    }
}

/** Tabelle: `cast` con attore e ruolo; le altre con le celle separate da "::". */
@Composable
private fun RowsEditor(f: FormField, rows: List<List<String>>, error: String?, enabled: Boolean, onChange: (List<List<String>>) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(f.def.title, style = MaterialTheme.typography.labelLarge)
        rows.forEachIndexed { i, row ->
            fun set(newRow: List<String>) = onChange(rows.toMutableList().also { it[i] = newRow })
            val removeLabel = stringResource(R.string.form_remove_row, i + 1)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (f.isCast) {
                    OutlinedTextField(
                        value = row.getOrElse(0) { "" }, onValueChange = { set(listOf(it, row.getOrElse(1) { "" })) },
                        enabled = enabled, singleLine = true, label = { Text(stringResource(R.string.form_actor)) },
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = row.getOrElse(1) { "" }, onValueChange = { set(listOf(row.getOrElse(0) { "" }, it)) },
                        enabled = enabled, singleLine = true, label = { Text(stringResource(R.string.form_role)) },
                        modifier = Modifier.weight(1f),
                    )
                } else {
                    OutlinedTextField(
                        value = row.joinToString("::"), onValueChange = { set(it.split("::")) },
                        enabled = enabled, singleLine = true, label = { Text(stringResource(R.string.form_row, i + 1)) },
                        supportingText = { Text(stringResource(R.string.form_cells_help)) },
                        modifier = Modifier.weight(1f),
                    )
                }
                IconButton(onClick = { onChange(rows.filterIndexed { j, _ -> j != i }) }, enabled = enabled) {
                    Icon(Icons.Filled.Delete, contentDescription = removeLabel)
                }
            }
        }
        error?.let { ErrorText(it) }
        TextButton(onClick = { onChange(rows + listOf(if (f.isCast) listOf("", "") else listOf(""))) }, enabled = enabled, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.form_add_row))
        }
    }
}
