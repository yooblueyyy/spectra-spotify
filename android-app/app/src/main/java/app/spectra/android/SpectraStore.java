package app.spectra.android;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Iterator;

/** chrome.storage.local-style JSON key/value store, persisted atomically to app storage. */
final class SpectraStore {
    private static SpectraStore instance;
    private final File file;
    private JSONObject data;

    static synchronized SpectraStore get(Context ctx) {
        if (instance == null) instance = new SpectraStore(ctx.getApplicationContext());
        return instance;
    }

    private SpectraStore(Context ctx) {
        file = new File(ctx.getFilesDir(), "spectra-store.json");
        JSONObject loaded = null;
        try {
            if (file.exists()) loaded = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
        data = loaded != null ? loaded : new JSONObject();
    }

    /** @param keysJson null, "key", or ["a","b"] — like chrome.storage.local.get */
    synchronized String getJson(String keysJson) {
        try {
            Object keys = keysJson == null || keysJson.equals("null") ? null : new JSONArray("[" + keysJson + "]").get(0);
            if (keys == null || keys == JSONObject.NULL) return data.toString();
            JSONObject out = new JSONObject();
            if (keys instanceof JSONArray) {
                JSONArray arr = (JSONArray) keys;
                for (int i = 0; i < arr.length(); i++) copy(arr.getString(i), out);
            } else {
                copy(String.valueOf(keys), out);
            }
            return out.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    private void copy(String key, JSONObject out) throws Exception {
        if (data.has(key)) out.put(key, data.get(key));
    }

    /** Merges the object and returns chrome-style changes: { key: { newValue } }. */
    synchronized JSONObject set(String objJson) {
        JSONObject changes = new JSONObject();
        try {
            JSONObject obj = new JSONObject(objJson);
            for (Iterator<String> it = obj.keys(); it.hasNext(); ) {
                String k = it.next();
                Object v = obj.get(k);
                data.put(k, v);
                changes.put(k, new JSONObject().put("newValue", v));
            }
            save();
        } catch (Exception ignored) {}
        return changes;
    }

    synchronized Object opt(String key) {
        return data.opt(key);
    }

    private void save() throws Exception {
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(file)) {
            Files.copy(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            tmp.delete();
        }
    }
}
