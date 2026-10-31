package io.github.mcauzzi.cinemanager.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.SystemClock
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
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import io.github.mcauzzi.cinemanager.R
import io.github.mcauzzi.cinemanager.core.form.Ean
import java.util.concurrent.Executors

enum class ScanMode { QR, EAN }

private const val SAME_CODE_PAUSE_MS = 5000L

/**
 * Anteprima della fotocamera con riconoscimento ML Kit (modello incluso, offline).
 * EAN: EAN-13, EAN-8, UPC-A, UPC-E con cifra di controllo valida; QR: il QR di abbinamento.
 * Alla lettura: vibrazione di conferma e [onDetected] una volta finché [enabled] resta vero.
 */
@Composable
fun CameraScanner(mode: ScanMode, enabled: Boolean, onDetected: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var asked by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it
        asked = true
    }
    LaunchedEffect(Unit) { if (!granted) launcher.launch(Manifest.permission.CAMERA) }

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
            Button(onClick = { launcher.launch(Manifest.permission.CAMERA) }) { Text(stringResource(R.string.camera_allow)) }
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
        val formats = if (mode == ScanMode.QR) {
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        } else {
            BarcodeScannerOptions.Builder().setBarcodeFormats(
                Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E,
            )
        }
        val scanner = BarcodeScanning.getClient(formats.build())
        val executor = Executors.newSingleThreadExecutor()
        val main = ContextCompat.getMainExecutor(context)
        // Lo stesso codice viene ignorato per qualche secondo (resta inquadrato mentre si cerca).
        var last: String? = null
        var lastAt = 0L
        controller.setEnabledUseCases(CameraController.IMAGE_ANALYSIS)
        controller.setImageAnalysisAnalyzer(
            executor,
            MlKitAnalyzer(listOf(scanner), ImageAnalysis.COORDINATE_SYSTEM_ORIGINAL, executor) { result ->
                val value = result.getValue(scanner)?.firstNotNullOfOrNull { b ->
                    b.rawValue?.takeIf { mode == ScanMode.QR || Ean.hasValidCheckDigit(it) || b.format == Barcode.FORMAT_UPC_E }
                } ?: return@MlKitAnalyzer
                main.execute {
                    val now = SystemClock.elapsedRealtime()
                    if (!active || (value == last && now - lastAt < SAME_CODE_PAUSE_MS)) return@execute
                    last = value
                    lastAt = now
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
            modifier = Modifier
                .fillMaxSize()
                .semantics { contentDescription = description },
        )
    }
}
