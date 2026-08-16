package tv.nodecast.app

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * First-run (and "change server") screen. Just asks for the server's
 * base URL, saves it, and hands off to MainActivity. Kept fully
 * D-pad navigable: two focusable views, EditText -> Save button.
 */
class SetupActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        val input = findViewById<EditText>(R.id.server_url_input)
        val saveButton = findViewById<Button>(R.id.save_button)

        // Prefill with the existing value (if any) so "change server" is a quick edit,
        // otherwise show an example so the user knows the expected format.
        val existing = Prefs.getServerUrl(this)
        if (existing != null) {
            input.setText(existing)
            input.setSelection(existing.length)
        }

        val save = {
            val typed = input.text?.toString().orEmpty()
            if (typed.isBlank()) {
                Toast.makeText(this, R.string.setup_error_empty, Toast.LENGTH_SHORT).show()
            } else {
                Prefs.setServerUrl(this, typed)
                startActivity(Intent(this, MainActivity::class.java))
                finish()
            }
        }

        saveButton.setOnClickListener { save() }
        input.setOnEditorActionListener { _, _, _ -> save(); true }

        input.requestFocus()
    }
}
