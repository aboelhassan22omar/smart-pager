package cc.aurexis.pager.cashier;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URLEncoder;

/**
 * The whole app: one WebView locked to the brand's server. Everything the cashier sees comes
 * from the server, so the app itself holds no business logic, only assets/pager.json
 * ({server, brand, key}) that the server writes into each brand's APK.
 */
public class MainActivity extends Activity {
    private static final int FILE_REQUEST = 1;

    private WebView web;
    private String server;
    private String startUrl;
    private ValueCallback<Uri[]> pendingFiles;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#1e1f21"));
        getWindow().setNavigationBarColor(Color.parseColor("#1e1f21"));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#1e1f21"));
        // targetSdk 35 draws edge to edge: keep the page clear of the system bars and keyboard.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#1e1f21"));
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        JSONObject config = readConfig();
        if (config == null) {
            showMessage("النسخة دي ناقصة", "نزّل التطبيق تاني من اللينك اللي وصلك.", false);
            return;
        }
        server = config.optString("server").replaceAll("/+$", "");
        String version = versionName();
        startUrl = server + "/app/" + enc(config.optString("brand")) + "/start?k=" + enc(config.optString("key"))
                + "&platform=android&v=" + enc(version) + "&model=" + enc(Build.MANUFACTURER + " " + Build.MODEL);

        setUpWebView(version);
        if (state == null || web.restoreState(state) == null) web.loadUrl(startUrl);
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private void setUpWebView(String version) {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // the bar chimes without a tap
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " PagerApp/" + version + " (android)");
        WebView.setWebContentsDebuggingEnabled(false);
        web.setLongClickable(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(), "PagerApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isOwn(url.toString())) return false;
                openOutside(url);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showMessage("مفيش اتصال بالإنترنت", "هنحاول تاني لوحدنا كل كام ثانية.", true);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // window.print() does nothing in a WebView by default: route it to Android printing.
                if (isOwn(url)) view.evaluateJavascript("window.print = function () { PagerApp.print(document.title); };", null);
                CookieManager.getInstance().flush();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                } catch (ActivityNotFoundException e) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            if (!isOwn(url)) {
                openOutside(Uri.parse(url));
                return;
            }
            try {
                String name = URLUtil.guessFileName(url, disposition, mime);
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                        .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url))
                        .addRequestHeader("User-Agent", userAgent)
                        .setMimeType(mime)
                        .setTitle(name)
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
                Toast.makeText(this, "بيتنزّل في Downloads", Toast.LENGTH_SHORT).show();
            } catch (RuntimeException e) {
                Toast.makeText(this, "التنزيل مش متاح على الجهاز ده", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /** A message page that retries the start URL by itself when `retry` is set. */
    private void showMessage(String title, String body, boolean retry) {
        String again = retry && startUrl != null
                ? "<script>setTimeout(function(){location.replace(" + JSONObject.quote(startUrl) + ")},5000)</script>"
                : "";
        String html = "<!doctype html><html lang=ar dir=rtl><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f21;color:#eceae6;"
                + "font-family:system-ui,sans-serif;text-align:center'><div style='padding:24px'><h1 style='font-size:22px;font-weight:600'>"
                + escape(title) + "</h1><p style='color:#a09d97'>" + escape(body) + "</p></div>" + again + "</body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private boolean isOwn(String url) {
        return server != null && url != null && (url.equals(server) || url.startsWith(server + "/"));
    }

    private void openOutside(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "مفيش برنامج يفتح اللينك ده", Toast.LENGTH_SHORT).show();
        }
    }

    private JSONObject readConfig() {
        try (InputStream in = getAssets().open("pager.json")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            JSONObject json = new JSONObject(out.toString("UTF-8"));
            String url = json.optString("server");
            boolean local = url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:");
            return (url.startsWith("https://") || local) && !json.optString("brand").isEmpty() ? json : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == FILE_REQUEST && pendingFiles != null) {
            pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pendingFiles = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    public void onBackPressed() {
        // Back never closes the cashier screen by accident.
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    /** Exposed to the page as window.PagerApp. */
    private class Bridge {
        @JavascriptInterface
        public void print(String title) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                String name = title == null || title.isEmpty() ? "QR" : title;
                pm.print(name, web.createPrintDocumentAdapter(name), new PrintAttributes.Builder().build());
            });
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
