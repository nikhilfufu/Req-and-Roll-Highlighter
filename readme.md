# Req and Roll Highlighter

Transform your Reqnroll/SpecFlow development experience with **Req and Roll Highlighter** - the ultimate VS Code extension for Gherkin feature files and C# step definitions.

## ✨ What Makes Req and Roll Special

Req and Roll isn't just another syntax highlighter. It's a comprehensive development tool that bridges the gap between your feature specifications and step implementations, making BDD development faster, more reliable, and enjoyable.

---

## 🚀 Key Features

### 🎨 Intelligent Syntax Highlighting
- **Smart Keyword Recognition**: Gherkin keywords (Feature, Scenario, Given, When, Then) are beautifully color-coded
- **Parameter Detection**: Automatically highlights captured parameters from your C# regex patterns
- **Outline Variables**: Distinct highlighting for `<placeholder>` tokens in Scenario Outlines

### 🔍 Seamless Navigation
- **Go-to-Definition**: F12 or right-click to jump directly from feature steps to C# methods
- **Smart Matching**: Intelligent algorithm finds the most specific step definition when multiple matches exist
- **Real-time Updates**: Changes to step definitions are reflected instantly in your feature files

### ⚡ Performance Optimized
- **Prefix Indexing**: Lightning-fast step matching even in large codebases
- **Version Caching**: Instant file switching with smart caching
- **Debounced Updates**: Smooth typing experience without lag

---

## 🎯 Perfect For

- **Reqnroll Teams**: Full compatibility with Reqnroll attributes and patterns
- **SpecFlow Projects**: Complete support for SpecFlow step definitions
- **BDD Practitioners**: Enhanced workflow for behavior-driven development
- **Test Automation Engineers**: Streamlined feature file management

---

## 🛠️ Supported Step Patterns

```csharp
[Given("I have (.*) items in my cart")]
[When("I proceed to checkout")]
[Then("I should see a total of (.*)")]
[And("the order should be confirmed")]

// Cucumber Expressions
[Given("I have {int} items")]
[When("I select {string} option")]
[Then("the result should be {float}")]
```

### Pattern Types Supported:
- **Regex Capture Groups**: `(.*)`, `(\d+)`, `([^"]*)`
- **Cucumber Expressions**: `{int}`, `{string}`, `{float}`, `{word}`, `{}`
- **Multiple Attributes**: Same method with different patterns

---

## 🎨 Color Scheme

| Element | Color | Description |
|---------|--------|-------------|
| **Feature, Scenario** | 🟣 Purple | Main structural keywords |
| **Given, When, Then** | 🔵 Blue | Step keywords |
| **Parameters** | 🟠 Orange | Captured regex groups |
| **Placeholders** | 🩷 Pink | Scenario outline variables |

---

## ⚙️ Configuration

No configuration required! Req and Roll works out of the box by:
- Automatically discovering C# step files in `**/Steps/**/*.cs`
- Monitoring file changes for real-time updates
- Building intelligent indexes for fast navigation

### Optional Settings
```json
{
  "files.associations": { "*.feature": "feature" }
}
```

---

## 🔥 Advanced Features

### Multi-Parameter Support
Handle complex steps with multiple parameters seamlessly:
```gherkin
When I search for "laptops" in category "electronics" with price range "500-1000"
```

### Scenario Outline Intelligence
Smart highlighting that distinguishes between regex captures and outline placeholders:
```gherkin
Scenario Outline: Purchase validation
  Given I have <quantity> items worth <amount>
  When I apply discount code "<code>"
  Then my total should be <final_amount>
```

### Performance Monitoring
- Built-in debouncing prevents lag during rapid typing
- Efficient caching system for large feature files
- Optimized regex compilation for step matching

---

## 🚦 Getting Started

1. **Install** Req and Roll Highlighter from VS Code marketplace
2. **Open** any `.feature` file in your Reqnroll/SpecFlow project
3. **Enjoy** immediate syntax highlighting and navigation features
4. **Press F12** on any step to jump to its C# definition

---

## 🤝 Compatibility

- **VS Code**: 1.74.0 or higher
- **Languages**: C# step definitions
- **Frameworks**: Reqnroll, SpecFlow
- **File Types**: `.feature`, `.cs`

---

## 📈 Changelog

### v0.0.4 - Latest
- Enhanced Cucumber Expression support
- Improved regex parsing for complex patterns
- Fixed edge cases with verbatim strings
- Performance optimizations for large projects

---

## 💬 Support

Found a bug or have a feature request? We'd love to hear from you!

**Req and Roll Highlighter** - Making BDD development a breeze! 🌟

---

*Built with ❤️ for the Reqnroll and SpecFlow community*