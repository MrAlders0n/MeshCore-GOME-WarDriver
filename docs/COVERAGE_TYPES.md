# 📡 Coverage Block Definitions

Coverage blocks are used to classify mesh network signal quality during wardriving sessions. Each block represents a specific communication state between your device and the mesh, based on whether transmissions were sent, received, repeated, or successfully routed.  Use these definitions to interpret your wardrive map data. 

---

## BIDIRECTIONAL (BIDIR)
Heard repeats from the mesh **AND** successfully routed through it.  Full bidirectional communication confirmed.

## TRANSMIT (TX)
Successfully routed through the mesh, but did **NOT** hear any repeats back.  Outbound path confirmed, inbound uncertain. 

## RECEIVE (RX)
Heard mesh traffic while wardriving, but did **NOT** transmit.  Passive reception only. 

## DEAD
A repeater heard the transmission, but either did nothing with it or when it repeated, no other radio received it. Message never made it through the mesh. 

## DROP
No repeats heard **AND** no successful route through the mesh. No communication in either direction. 