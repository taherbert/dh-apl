# Textual Configuration Interface

Source: https://github.com/simulationcraft/simc/wiki/TextualConfigurationInterface

## Presentation

The textual configuration interface (TCI) is a collection of textual options and commands usable in Simulationcraft across three contexts:

- The **overrides** tab within the graphical user interface (Simulationcraft.exe)
- Text files (typically with .simc extension) for GUI or command-line clients
- Direct arguments for command-line clients

## Options Scopes

Simc files parse sequentially, with option placement mattering for some declarations. Common scope types include:

- **Global**: Declaration location irrelevant; last declaration typically prevails
- **Current character**: Affects the most recently declared character
- **Ulterior characters**: Affects characters declared later in the file

## Characters Encoding

Simulationcraft uses UTF-8 encoding. While Latin1 is compatible for common characters, UTF-8 is the universal standard. Basic text editors like Notepad may use incompatible regional encodings. Tools like Notepad++ support UTF-8 selection for universal compatibility across armory sources.

## Textual Formatting

### Comments

Comments use the `#` symbol:

```
# This is a comment
```

### Multiline Options

Long options like `actions` and `raid_events` can span multiple lines using `+=`:

```
actions=foo
actions+=,bar
actions+=,baz
```

### Whitespace

Whitespace terminates parsed lines by default. Double quotes preserve internal whitespace:

```
enemy="foo bar"
```

### Sequences

Commands require separation operators (typically `/`):

```
raid_events=/event1,option1,option2
raid_events+=/event2,option1,option2
```

### Standard String Tokenization

String conversion to identifiers follows rules:

1. Spaces become underscores (`_`)
2. Non-alphanumeric characters are removed

## Text Templating

Templates use declaration and reference syntax:

```
$(variable)=content
$(variable)
```

Example:

```
$(light_the_fire)=!ticking&buff.t11_4pc_caster.down
actions+=/sunfire,if=$(light_the_fire)&!dot.moonfire.remains>0
```

## Includes

External .simc files can be included explicitly or implicitly:

```
global-config.simc
input=global-config.simc
c:\global-config.simc
```

The **path** option (global scope) specifies search directories separated by `|`, `,`, or `;`:

```
path="c:\includes|.\profiles|..\simc_scripts"
```

Since Simulationcraft 7.0.3, a `current_base_name` template variable automatically contains the included file's base name during parsing.
