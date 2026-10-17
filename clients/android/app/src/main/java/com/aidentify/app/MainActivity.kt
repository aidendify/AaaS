package app.agentsphere.client

import android.app.AlertDialog
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/** Phone window onto a hosted AIdentify. The public address is stored on the device. */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("agentsphere", MODE_PRIVATE) }
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = fileCallback
        fileCallback = null
        if (cb == null) return@registerForActivityResult
        cb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = true
        s.mediaPlaybackRequiresUserGesture = false
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return try {
                    pickFile.launch(params.createIntent())
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    cb.onReceiveValue(null)
                    false
                }
            }
        }
        setContentView(web)
        title = "AIdentify"
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (this@MainActivity::web.isInitialized && web.canGoBack()) web.goBack() else finish()
            }
        })
        val saved = prefs.getString("base", "").orEmpty()
        if (saved.startsWith("http://") || saved.startsWith("https://")) load(saved)
        else askAddress(saved, required = true)
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, 1, 0, "Change server")
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == 1) {
            askAddress(prefs.getString("base", "").orEmpty(), required = false)
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    private fun load(url: String) {
        web.loadUrl(url)
    }

    private fun askAddress(current: String, required: Boolean) {
        val input = EditText(this)
        input.setText(current.ifBlank { "https://" })
        input.hint = "https://your-server.example"
        input.setSingleLine(true)
        val box = LinearLayout(this)
        val pad = (16 * resources.displayMetrics.density).toInt()
        box.setPadding(pad, pad, pad, 0)
        box.addView(input, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        val dialog = AlertDialog.Builder(this)
            .setTitle("AIdentify server")
            .setMessage("This phone opens the hosted site. Point it at your public address, or at a computer on the same network.")
            .setView(box)
            .setCancelable(!required)
            .setPositiveButton("Continue", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val url = input.text.toString().trim().trimEnd('/')
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    Toast.makeText(this, "Start with http:// or https://", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                prefs.edit().putString("base", url).apply()
                load(url)
                dialog.dismiss()
            }
        }
        if (!required) dialog.setOnCancelListener { }
        dialog.show()
    }
}
