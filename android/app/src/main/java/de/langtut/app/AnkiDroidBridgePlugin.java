package de.langtut.app;

import android.content.Context;
import android.content.ContentValues;
import android.content.SharedPreferences;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;
import com.ichi2.anki.FlashCardsContract;
import com.ichi2.anki.api.AddContentApi;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** Thin AnkiDroid adapter. Learning and model-selection rules remain in the shared TypeScript runtime. */
@CapacitorPlugin(name = "AnkiDroidBridge", permissions = { @Permission(alias = "anki", strings = { "com.ichi2.anki.permission.READ_WRITE_DATABASE" }) })
public class AnkiDroidBridgePlugin extends Plugin {
  private static final String SENTINEL = "langtut-managed:v1";
  private static final String CSS = "/* " + SENTINEL + " */ .card{font-family:system-ui;font-size:24px;text-align:left;color:#17201d;background:#f7f4ed;padding:24px}.target{font-size:1.35em;font-weight:700}.example{margin-top:18px;color:#41665a}.source{margin-top:24px;font-size:.55em;color:#777}";
  private static final String[] COMMON = {"ItemId", "ModuleId", "PackageId", "Origin", "SchemaVersion"};
  private static final String[] LANGUAGE = {"Target", "Source", "ExampleTarget", "ExampleSource", "Notes", "ItemId", "ModuleId", "PackageId", "Origin", "SchemaVersion"};
  private AddContentApi api() { return new AddContentApi(getContext()); }
  private SharedPreferences owned() { return getContext().getSharedPreferences("langtut-ankidroid-models", Context.MODE_PRIVATE); }

  @PluginMethod public void metrics(PluginCall call) {
    if (getPermissionState("anki") != PermissionState.GRANTED) { requestPermissionForAlias("anki", call, "ankiPermissionResult"); return; }
    new Thread(() -> {
      try {
        AddContentApi api = api(); int version = api.getApiHostSpecVersion();
        if (version < 0) { call.resolve(unreachable("AnkiDroid ist nicht installiert.")); return; }
        String packageId = call.getString("packageId", "slowakisch-deutsch"); String base = "tag:langtut tag:package::" + packageId;
        JSObject result = new JSObject(); result.put("reachable", true); result.put("version", version);
        result.put("dueReviews", cardCount(base + " is:due")); result.put("newCards", cardCount(base + " is:new")); result.put("leeches", cardCount(base + " tag:leech")); result.put("lapses7d", cardCount(base + " rated:7:1")); call.resolve(result);
      } catch (Exception error) { call.resolve(unreachable(error.getMessage())); }
    }).start();
  }
  @PermissionCallback private void ankiPermissionResult(PluginCall call) {
    if (getPermissionState("anki") == PermissionState.GRANTED) metrics(call);
    else call.resolve(unreachable("AnkiDroid-Zugriff wurde nicht erlaubt."));
  }

  @PluginMethod public void setupPreview(PluginCall call) { new Thread(() -> { try { call.resolve(preview(call.getString("deck", "Langtut"))); } catch (Exception error) { call.reject(error.getMessage(), error); } }).start(); }
  @PluginMethod public void applySetup(PluginCall call) {
    new Thread(() -> {
      try {
        String deck = call.getString("deck", "Langtut"); JSObject before = preview(deck); JSONArray models = before.getJSONArray("models");
        for (int index = 0; index < models.length(); index++) if ("conflict".equals(models.getJSONObject(index).getString("action"))) { call.reject(models.getJSONObject(index).getString("name") + " existiert ohne Langtut-Sentinel und wird nicht verändert."); return; }
        AddContentApi api = api(); long deckId = deckId(api, deck, true);
        for (ModelDefinition definition : definitions()) if (modelId(api, definition.name) == null) {
          Long id = api.addNewCustomModel(definition.name, definition.fields, definition.cards, definition.fronts, definition.backs, CSS, deckId, 0);
          if (id == null) throw new IllegalStateException("AnkiDroid konnte " + definition.name + " nicht erstellen"); owned().edit().putLong(definition.name, id).apply();
        }
        call.resolve(preview(deck));
      } catch (Exception error) { call.reject(error.getMessage(), error); }
    }).start();
  }

  @PluginMethod public void addItems(PluginCall call) {
    new Thread(() -> {
      try {
        AddContentApi api = api(); String packageId = call.getString("packageId", "slowakisch-deutsch"); String deck = call.getString("deck", "Langtut"); long deckId = deckId(api, deck, false);
        JSArray input = call.getArray("items", new JSArray()); JSArray output = new JSArray();
        for (int index = 0; index < input.length(); index++) {
          JSONObject item = input.getJSONObject(index); String kind = item.getString("kind"); ModelDefinition definition = definition(kind); Long modelId = modelId(api, definition.name);
          if (modelId == null || owned().getLong(definition.name, -1) != modelId) { output.put(JSONObject.NULL); continue; }
          String[] fields = fields(item, packageId, kind); String moduleId = item.getString("moduleId"); HashSet<String> tags = new HashSet<>(Arrays.asList("langtut", "package::" + packageId, "module::" + moduleId, "kind::" + kind));
          if (item.has("functionId")) tags.add("target::function::" + item.optString("functionId"));
          if (item.has("milestoneId")) tags.add("target::grammar::" + item.optString("milestoneId"));
          JSONArray itemTags = item.optJSONArray("tags"); if (itemTags != null) for (int tag = 0; tag < itemTags.length(); tag++) tags.add(itemTags.getString(tag));
          Long noteId = api.addNote(modelId, deckId, fields, tags); output.put(noteId == null ? JSONObject.NULL : noteId);
        }
        JSObject result = new JSObject(); result.put("noteIds", output); call.resolve(result);
      } catch (Exception error) { call.reject(error.getMessage(), error); }
    }).start();
  }

  @PluginMethod public void removeNotes(PluginCall call) {
    new Thread(() -> { try { JSArray ids = call.getArray("noteIds", new JSArray()); for (int index = 0; index < ids.length(); index++) getContext().getContentResolver().delete(Uri.withAppendedPath(FlashCardsContract.Note.CONTENT_URI, String.valueOf(ids.getLong(index))), null, null); call.resolve(); } catch (Exception error) { call.reject(error.getMessage(), error); } }).start();
  }

  @PluginMethod public void activateNotes(PluginCall call) {
    new Thread(() -> {
      try {
        JSArray ids = call.getArray("noteIds", new JSArray());
        for (int index = 0; index < ids.length(); index++) setSuspended("nid:" + ids.getLong(index), false);
        call.resolve();
      } catch (Exception error) { call.reject(error.getMessage(), error); }
    }).start();
  }

  @PluginMethod public void syncModuleAvailability(PluginCall call) {
    new Thread(() -> {
      try {
        AddContentApi api = api(); String packageId = call.getString("packageId", "slowakisch-deutsch");
        JSArray learning = call.getArray("learningModuleIds", new JSArray());
        setSuspended("tag:langtut tag:package::" + packageId + " -is:suspended", true);
        for (int index = 0; index < learning.length(); index++) {
          setSuspended("tag:langtut tag:package::" + packageId + " tag:module::" + learning.getString(index) + " tag:kind::vocab", false);
        }
        call.resolve();
      } catch (Exception error) { call.reject(error.getMessage(), error); }
    }).start();
  }

  /** Read-only review selection and progress counts; policy stays in the TypeScript runtime. */
  @PluginMethod public void cardProgress(PluginCall call) {
    new Thread(() -> {
      try {
        String packageId = call.getString("packageId", "slowakisch-deutsch"), moduleId = call.getString("moduleId", "");
        String base = "tag:langtut tag:package::" + packageId + " tag:module::" + moduleId;
        JSObject statuses = new JSObject(); statuses.put("suspended", cardCount(base + " is:suspended")); statuses.put("new", cardCount(base + " is:new")); statuses.put("learning", cardCount(base + " is:learn")); statuses.put("fresh", cardCount(base + " is:review -prop:ivl>=21")); statuses.put("mature", cardCount(base + " is:review prop:ivl>=21"));
        JSObject result = new JSObject(); result.put("total", cardCount(base)); result.put("statuses", statuses); result.put("dueAutomatic", cardCount(base + " is:due (tag:kind::chunk OR tag:kind::rule)")); result.put("difficultVocab", cardCount(base + " tag:kind::vocab (tag:leech OR prop:lapses>0)")); call.resolve(result);
      } catch (Exception error) { call.reject(error.getMessage(), error); }
    }).start();
  }

  @PluginMethod public void nextAutomaticCard(PluginCall call) {
    new Thread(() -> {
      try {
        String packageId = call.getString("packageId", "slowakisch-deutsch"), moduleId = call.getString("moduleId", ""), target = call.getString("target", "");
        String targetTag = target.isEmpty() ? "" : " tag:target::" + target.replace(":", "::");
        JSObject result = new JSObject(); result.put("cardId", firstCardId("tag:langtut tag:package::" + packageId + " tag:module::" + moduleId + targetTag + " is:due (tag:kind::chunk OR tag:kind::rule)")); call.resolve(result);
      } catch (Exception error) { call.reject(error.getMessage(), error); }
    }).start();
  }

  /** Uses AnkiDroid's public ReviewInfo provider so Anki remains the SRS authority. */
  @PluginMethod public void gradeAutomaticCard(PluginCall call) {
    new Thread(() -> {
      try {
        long cardId = call.getLong("cardId"); String outcome = call.getString("outcome", "again");
        try (android.database.Cursor cursor = getContext().getContentResolver().query(FlashCardsContract.Card.CONTENT_URI, null, "cid:" + cardId, null, null)) {
          if (cursor == null || !cursor.moveToFirst()) { JSObject result = new JSObject(); result.put("graded", false); call.resolve(result); return; }
          ContentValues values = new ContentValues(); values.put(FlashCardsContract.ReviewInfo.NOTE_ID, cursor.getLong(cursor.getColumnIndexOrThrow(FlashCardsContract.Card.NOTE_ID))); values.put(FlashCardsContract.ReviewInfo.CARD_ORD, cursor.getInt(cursor.getColumnIndexOrThrow(FlashCardsContract.Card.CARD_ORD))); values.put(FlashCardsContract.ReviewInfo.EASE, "good".equals(outcome) ? 3 : 1); values.put(FlashCardsContract.ReviewInfo.TIME_TAKEN, 0);
          JSObject result = new JSObject(); result.put("graded", getContext().getContentResolver().update(FlashCardsContract.ReviewInfo.CONTENT_URI, values, null, null) > 0); call.resolve(result);
        }
      } catch (Exception error) { call.reject(error.getMessage(), error); }
    }).start();
  }

  private JSObject preview(String deck) throws Exception {
    AddContentApi api = api(); if (api.getApiHostSpecVersion() < 0) throw new IllegalStateException("AnkiDroid ist nicht installiert.");
    JSObject result = new JSObject(); JSObject deckResult = new JSObject(); deckResult.put("name", deck); deckResult.put("action", deckId(api, deck, false) < 0 ? "create" : "none"); result.put("deck", deckResult); JSArray models = new JSArray();
    for (ModelDefinition definition : definitions()) { Long id = modelId(api, definition.name); boolean managed = id != null && owned().getLong(definition.name, -1) == id; String action = id == null ? "create" : managed && Arrays.equals(api.getFieldList(id), definition.fields) ? "none" : "conflict"; JSObject model = new JSObject(); model.put("name", definition.name); model.put("action", action); model.put("managed", managed); model.put("fields", new JSArray(Arrays.asList(definition.fields))); model.put("changes", new JSArray(action.equals("none") ? Arrays.asList() : Arrays.asList("fields", "templates", "css"))); models.put(model); }
    result.put("models", models); return result;
  }
  private int cardCount(String query) { try (android.database.Cursor cursor = getContext().getContentResolver().query(FlashCardsContract.Card.CONTENT_URI, null, query, null, null)) { return cursor == null ? 0 : cursor.getCount(); } catch (Exception ignored) { return 0; } }
  private Long firstCardId(String query) { try (android.database.Cursor cursor = getContext().getContentResolver().query(FlashCardsContract.Card.CONTENT_URI, null, query, null, null)) { if (cursor == null || !cursor.moveToFirst()) return null; return cursor.getLong(cursor.getColumnIndexOrThrow(FlashCardsContract.Card._ID)); } }
  private void setSuspended(String query, boolean suspend) { try (android.database.Cursor cursor = getContext().getContentResolver().query(FlashCardsContract.Card.CONTENT_URI, null, query, null, null)) { if (cursor == null) return; int idIndex = cursor.getColumnIndex(FlashCardsContract.Card._ID); int typeIndex = cursor.getColumnIndex(FlashCardsContract.Card.TYPE); while (cursor.moveToNext()) { ContentValues values = new ContentValues(); values.put(FlashCardsContract.Card.RAW_QUEUE, suspend ? -1 : (cursor.getInt(typeIndex) == 0 ? 0 : 1)); getContext().getContentResolver().update(Uri.withAppendedPath(FlashCardsContract.Card.CONTENT_URI, String.valueOf(cursor.getLong(idIndex))), values, null, null); } } }
  private JSObject unreachable(String error) { JSObject result = new JSObject(); result.put("reachable", false); result.put("dueReviews", 0); result.put("newCards", 0); result.put("leeches", 0); result.put("lapses7d", 0); result.put("error", error == null ? "AnkiDroid nicht erreichbar" : error); return result; }
  private Long modelId(AddContentApi api, String name) { Map<Long, String> models = api.getModelList(); if (models == null) return null; for (Map.Entry<Long, String> entry : models.entrySet()) if (name.equals(entry.getValue())) return entry.getKey(); return null; }
  private long deckId(AddContentApi api, String name, boolean create) { Map<Long, String> decks = api.getDeckList(); if (decks != null) for (Map.Entry<Long, String> entry : decks.entrySet()) if (name.equals(entry.getValue())) return entry.getKey(); if (!create) return -1; Long id = api.addNewDeck(name); if (id == null) throw new IllegalStateException("AnkiDroid konnte das Deck nicht erstellen"); return id; }
  private String[] fields(JSONObject item, String packageId, String kind) { String[] common = {item.optString("itemId"), item.optString("moduleId"), packageId, "langtut:" + packageId + ":" + item.optString("moduleId"), "1"}; if ("rule".equals(kind)) return concat(new String[]{item.optString("target"), item.optString("source"), item.optString("notes"), item.optString("exampleTarget") + "<br>" + item.optString("exampleSource"), item.optString("milestoneId")}, common); return concat(new String[]{item.optString("target"), item.optString("source"), item.optString("exampleTarget"), item.optString("exampleSource"), item.optString("notes")}, common); }
  private String[] concat(String[] left, String[] right) { String[] value = Arrays.copyOf(left, left.length + right.length); System.arraycopy(right, 0, value, left.length, right.length); return value; }
  private ModelDefinition definition(String kind) { return "vocab".equals(kind) ? definitions()[0] : "chunk".equals(kind) ? definitions()[1] : definitions()[2]; }
  private ModelDefinition[] definitions() { String[] cards2 = {"Ziel–Quelle", "Quelle–Ziel"}; String[] fronts2 = {"<div class=target>{{Target}}</div><div class=example>{{ExampleTarget}}</div>", "<div class=target>{{Source}}</div><div class=example>{{ExampleSource}}</div>"}; String[] backs2 = {"{{FrontSide}}<hr>{{Source}}<div class=example>{{ExampleSource}}</div>", "{{FrontSide}}<hr>{{Target}}<div class=example>{{ExampleTarget}}</div>"}; return new ModelDefinition[]{new ModelDefinition("LangtutVocabV1", LANGUAGE, cards2, fronts2, backs2), new ModelDefinition("LangtutChunkV1", LANGUAGE, cards2, fronts2, backs2), new ModelDefinition("LangtutRuleV1", concat(new String[]{"Title", "Prompt", "Explanation", "Examples", "MilestoneId"}, COMMON), new String[]{"Regel"}, new String[]{"<div class=target>{{Title}}</div><div>{{Prompt}}</div>"}, new String[]{"{{FrontSide}}<hr><div>{{Explanation}}</div><div class=example>{{Examples}}</div>"})}; }
  private static class ModelDefinition { final String name; final String[] fields, cards, fronts, backs; ModelDefinition(String name, String[] fields, String[] cards, String[] fronts, String[] backs) { this.name = name; this.fields = fields; this.cards = cards; this.fronts = fronts; this.backs = backs; } }
}
