package io.github.mcauzzi.cinemanager.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageAnalysis
import androidx.camera.mlkit.vision.MlKitAnalyzer
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.core.form.Ean
import java.util.concurrent.Executors

enum class ScanMode { QR, EAN }

/**
 * Un codice già letto torna valido solo dopo essere uscito dall'inquadratura per questo tempo:
 * se la ricerca fallisce (rete, 429, 5xx) non riparte da sola finché il DVD resta davanti alla
 * fotocamera (si usa "Riprova" o si inquadra di nuovo).
 */
private const val LEFT_FRAME_MS = 1500L

/**
 * Anteprima della fotocamera con riconoscimento ML Kit (modello incluso, offline).
 * EAN: EAN-13, EAN-8, UPC-A con cifra di controllo valida, UPC-E espanso in UPC-A (12 cifre,
 * come lo normalizza il server); QR: il QR di abbinamento.
 * Alla lettura: vibrazione di conferma e [onDetected] una volta finché [enabled] resta vero.
 */
@Composable
fun CameraScanner(mode: ScanMode, enabled: Boolean, onDetected: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    fun hasPermission() = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    var granted by remember { mutableStateOf(hasPermission()) }
    // Sopravvive alla rotazione: niente nuova richiesta automatica a ogni rotazione e, dopo un
    // rifiuto, compare camera_denied invece di camera_needed.
    var asked by rememberSaveable { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it
        asked = true
    }
    LaunchedEffect(Unit) { if (!granted && !asked) launcher.launch(Manifest.permission.CAMERA) }
    // Permesso concesso dalle impostazioni di sistema mentre l'app era in secondo piano.
    LifecycleResumeEffect(Unit) {
        granted = hasPermission()
        onPauseOrDispose {}
    }

    if (!granted) {
        Column(
            modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                stringResource(if (asked) R.string.camera_denied else R.string.camera_needed),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyMedium,
            )
            // Dopo un rifiuto definitivo Android non mostra più la richiesta: si aprono le
            // impostazioni dell'app.
            val activity = context.findActivity()
            val blocked = asked && activity != null &&
                !ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.CAMERA)
            Button(onClick = {
                if (blocked) {
                    context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
                    )
                } else {
                    launcher.launch(Manifest.permission.CAMERA)
                }
            }) { Text(stringResource(if (blocked) R.string.camera_open_settings else R.string.camera_allow)) }
        }
        return
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    val view = LocalView.current
    val callback by rememberUpdatedState(onDetected)
    val active by rememberUpdatedState(enabled)
    val description = stringResource(if (mode == ScanMode.QR) R.string.camera_preview_qr else R.string.camera_preview_ean)

    val controller = remember { LifecycleCameraController(context) }
    DisposableEffect(mode, lifecycleOwner) {
        val options = BarcodeScannerOptions.Builder().run {
            if (mode == ScanMode.QR) setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            else setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E)
        }.build()
        val scanner = BarcodeScanning.getClient(options)
        val executor = Executors.newSingleThreadExecutor()
        val main = ContextCompat.getMainExecutor(context)
        // Lo stesso codice viene ignorato finché resta inquadrato (vedi LEFT_FRAME_MS).
        var last: String? = null
        var lastSeenAt = 0L
        controller.setEnabledUseCases(CameraController.IMAGE_ANALYSIS)
        controller.setImageAnalysisAnalyzer(
            executor,
            MlKitAnalyzer(listOf(scanner), ImageAnalysis.COORDINATE_SYSTEM_ORIGINAL, executor) { result ->
                val value = result.getValue(scanner)?.firstNotNullOfOrNull { b -> accepted(mode, b) } ?: return@MlKitAnalyzer
                main.execute {
                    val now = SystemClock.elapsedRealtime()
                    if (value == last && now - lastSeenAt < LEFT_FRAME_MS) {
                        lastSeenAt = now // ancora inquadrato
                        return@execute
                    }
                    if (!active) return@execute
                    last = value
                    lastSeenAt = now
                    view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                    callback(value)
                }
            },
        )
        controller.bindToLifecycle(lifecycleOwner)
        onDispose {
            controller.unbind()
            controller.clearImageAnalysisAnalyzer()
            scanner.close()
            executor.shutdown()
        }
    }
    Box(modifier) {
        AndroidView(
            factory = { ctx ->
                PreviewView(ctx).apply {
                    this.controller = controller
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                }
            },
            modifier = Modifier.fillMaxSize().semantics { contentDescription = description },
        )
    }
}

/** Valore da passare all'app, o null se il codice va ignorato. */
private fun accepted(mode: ScanMode, b: Barcode): String? {
    val raw = b.rawValue ?: return null
    return when {
        mode == ScanMode.QR -> raw
        // UPC-E compresso: inviato così sarebbe letto come un EAN-8 diverso.
        b.format == Barcode.FORMAT_UPC_E -> Ean.upcEToUpcA(raw)
        Ean.hasValidCheckDigit(raw) -> raw
        else -> null
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
