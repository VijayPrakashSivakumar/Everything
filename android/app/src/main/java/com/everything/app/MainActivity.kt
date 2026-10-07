package com.everything.app

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen

/**
 * Single-Activity native wrapper around the unchanged web app.
 * Native splash (Theme.Starting, #F5F6FB + brand mark) is kept until
 * WebView.onPageCommitVisible fires — index.html shows #bootSplash during
 * parsing, so the replacement is the animating web splash, never white.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val PROD_URL = "https://everything-app-zeta.vercel.app/"
        private const val FALLBACK_DISMISS_MS = 4000L
    }

    private lateinit var webView: WebView

    @Volatile private var webReady = false

    private var fileChooser: ValueCallback<Array<Uri>>? = null
    private val pickFile = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        val uris = if (it.resultCode == RESULT_OK) {
            val data = it.data
            when {
                data?.clipData != null -> Array(data.clipData!!.itemCount) { i ->
                    data.clipData!!.getItemAt(i).uri
                }
                data?.data != null -> arrayOf(data.data!!)
                else -> null
            }
        } else null
        fileChooser?.onReceiveValue(uris)
        fileChooser = null
    }

    /** Optional pixel-perfect handoff: page calls window.AndroidSplash.hide(). */
    inner class SplashBridge {
        @JavascriptInterface
        fun hide() {
            Handler(Looper.getMainLooper()).post { webReady = true }
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { !webReady }

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)
        webView.setBackgroundColor(Color.parseColor("#F5F6FB"))

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
        }
        webView.addJavascriptInterface(SplashBridge(), "AndroidSplash")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageCommitVisible(view: WebView, url: String) {
                super.onPageCommitVisible(view, url)
                webReady = true
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val uri = request.url
                val scheme = uri.scheme?.lowercase()
                if (scheme != "http" && scheme != "https") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    return true
                }
                val appHost = Uri.parse(PROD_URL).host
                return if (uri.host == appHost) {
                    false
                } else {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileChooser?.onReceiveValue(null)
                fileChooser = callback
                return runCatching {
                    pickFile.launch(params.createIntent())
                    true
                }.getOrDefault(false)
            }
        }

        onBackPressedDispatcher.addCallback(this) {
            if (::webView.isInitialized && webView.canGoBack()) webView.goBack()
            else {
                remove()
                onBackPressedDispatcher.onBackPressed()
            }
        }

        Handler(Looper.getMainLooper()).postDelayed(
            { webReady = true },
            FALLBACK_DISMISS_MS
        )

        if (savedInstanceState == null) {
            webView.loadUrl(intent?.data?.toString() ?: PROD_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }
        handleViewIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleViewIntent(intent)
    }

    private fun handleViewIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (intent.action != Intent.ACTION_VIEW) return
        val appHost = Uri.parse(PROD_URL).host
        if (uri.host == appHost && ::webView.isInitialized) {
            webView.loadUrl(uri.toString())
            findViewById<View>(android.R.id.content)?.bringToFront()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::webView.isInitialized) webView.saveState(outState)
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}

