import gi,os,json
from pathlib import Path
gi.require_version('Gtk','4.0')
from gi.repository import Gtk,GLib
root=Path(os.environ['XDG_RUNTIME_DIR'])
assert 'amplefile-niri-test-' in str(root)
app=Gtk.Application(application_id='com.amplefile.NiriInputTest')
def activate(app):
 w=Gtk.ApplicationWindow(application=app,title='AmpleFile isolated input fixture');w.set_decorated(False);w.set_default_size(1000,700)
 box=Gtk.Fixed();w.set_child(box)
 button=Gtk.Button(label='Test pointer');button.set_size_request(200,40);box.put(button,100,100)
 entry=Gtk.Entry();entry.set_size_request(400,40);box.put(entry,100,200)
 state={'clicked':0,'text':'','positions':[]}
 def save(): (root/'result.json').write_text(json.dumps(state))
 def clicked(_):state['clicked']+=1;save()
 def changed(_):state['text']=entry.get_text();save()
 gesture=Gtk.GestureClick();gesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
 def pressed(g,n,x,y):state['positions'].append([x,y]);save()
 gesture.connect('pressed',pressed);w.add_controller(gesture)
 button.connect('clicked',clicked);entry.connect('changed',changed)
 w.present();save();GLib.timeout_add(800,lambda:(root/'fixture-ready').touch() or False)
app.connect('activate',activate);app.run(None)
