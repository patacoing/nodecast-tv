package tv.nodecast.app

import android.content.Context

/**
 * Tiny SharedPreferences wrapper around the single setting this app has:
 * the base URL of the user's self-hosted NodeCast TV server.
 */
object Prefs {

    private const val FILE_NAME = "nodecast_prefs"
    private const val KEY_SERVER_URL = "server_url"

    private fun prefs(context: Context) =
        context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    fun getServerUrl(context: Context): String? {
        val url = prefs(context).getString(KEY_SERVER_URL, null)
        return if (url.isNullOrBlank()) null else url
    }

    fun setServerUrl(context: Context, rawUrl: String) {
        prefs(context).edit().putString(KEY_SERVER_URL, normalize(rawUrl)).apply()
    }

    /**
     * Accepts whatever the user typed - a bare host/IP, a host with a port,
     * or a full URL - and turns it into something WebView.loadUrl() can use.
     */
    fun normalize(rawUrl: String): String {
        var url = rawUrl.trim()
        if (!url.contains("://")) {
            url = "http://$url"
        }
        while (url.endsWith("/")) {
            url = url.dropLast(1)
        }
        return url
    }
}
