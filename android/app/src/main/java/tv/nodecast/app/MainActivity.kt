package tv.nodecast.app

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * The entire app is one full-screen WebView pointed at the user's
 * self-hosted NodeCast TV server. All navigation, D-pad focus handling
 * and UI logic lives in the web app itself (see public/js/dpad.js) -
 * this activity deliberately does no key/focus handling of its own.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var fullscreenContainer: FrameLayout
    private lateinit var errorView: View
    private var serverUrl: String? = null

    // HTML5 fullscreen video (WebChromeClient.onShowCustomView) state.
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val url = Prefs.getServerUrl(this)
        if (url == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        serverUrl = url

        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        fullscreenContainer = findViewById(R.id.fullscreen_container)
        errorView = findViewById(R.id.error_view)

        findViewById<Button>(R.id.error_retry_button).setOnClickListener { retry() }
        findViewById<Button>(R.id.error_change_server_button).setOnClickListener { openSetup() }

        setupWebView()
        webView.loadUrl(url)

        onBackPressedDispatcher.addCallback(this, backCallback)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(true)

        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        // CRITICAL: the web app stores its JWT auth token in localStorage.
        // Without DOM storage enabled, login silently fails.
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        webView.webViewClient = NodeCastWebViewClient()
        webView.webChromeClient = NodeCastWebChromeClient()
    }

    /** Keeps every navigation inside this WebView instead of the system browser. */
    private inner class NodeCastWebViewClient : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val scheme = request.url.scheme
            if (scheme == "http" || scheme == "https") {
                // Let the WebView load it itself, i.e. stay inside the app.
                return false
            }
            // Anything else (intent://, market://, tel:, ...) has no in-WebView
            // representation; hand it to the system if something can open it,
            // otherwise just ignore it rather than crashing.
            return try {
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                true
            } catch (_: Exception) {
                true
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            hideError()
        }

        @TargetApi(Build.VERSION_CODES.M)
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                showError()
            }
        }

        @Suppress("DEPRECATION", "OverridingDeprecatedMember")
        override fun onReceivedError(view: WebView, errorCode: Int, description: String?, failingUrl: String?) {
            // Only reached on API < 23 (pre-M WebView implementations dispatch
            // this legacy callback instead of the WebResourceRequest one above).
            showError()
        }
    }

    /** Handles HTML5 <video> fullscreen (requestFullscreen) and permission prompts. */
    private inner class NodeCastWebChromeClient : WebChromeClient() {

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customViewCallback = callback

            fullscreenContainer.addView(
                view,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            )
            fullscreenContainer.visibility = View.VISIBLE
            webView.visibility = View.GONE
        }

        override fun onHideCustomView() {
            hideCustomView()
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread { request.grant(request.resources) }
        }
    }

    private fun hideCustomView() {
        val view = customView ?: return
        fullscreenContainer.visibility = View.GONE
        fullscreenContainer.removeView(view)
        webView.visibility = View.VISIBLE
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
    }

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            when {
                customView != null -> hideCustomView()
                webView.canGoBack() -> webView.goBack()
                else -> {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        }
    }

    // Long-press BACK is the escape hatch for a user stuck on a wrong/unreachable
    // server address - it always gets them to the setup screen, regardless of
    // what the page (or the D-pad nav inside it) is currently doing.
    override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            openSetup()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    private fun showError() {
        webView.visibility = View.GONE
        errorView.visibility = View.VISIBLE
    }

    private fun hideError() {
        errorView.visibility = View.GONE
        webView.visibility = View.VISIBLE
    }

    private fun retry() {
        hideError()
        val url = serverUrl
        if (url != null) {
            webView.loadUrl(url)
        }
    }

    private fun openSetup() {
        startActivity(Intent(this, SetupActivity::class.java))
    }

    override fun onDestroy() {
        // On first run onCreate hands off to SetupActivity and finishes before
        // setContentView, so these views were never assigned - yet finish()
        // still brings us here. Touching them unguarded killed the whole
        // process, taking the setup screen down with it.
        if (::fullscreenContainer.isInitialized) {
            fullscreenContainer.removeAllViews()
        }
        if (::webView.isInitialized) {
            webView.apply {
                clearHistory()
                (parent as? ViewGroup)?.removeView(this)
                destroy()
            }
        }
        super.onDestroy()
    }
}
